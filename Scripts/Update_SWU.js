#!/usr/bin/env node
/**
 * Mise à jour de la BDD Star Wars Unlimited pour TCG Arena.
 *
 *  1. Récupère la liste des sets (api.swu-db.com/sets) et garde les sets de base (isBaseSet)
 *  2. Pour chaque set : Sets/SWU_<SET>.json sert de cache.
 *       - fichier présent  → rien n'est re-téléchargé ni re-traité
 *       - fichier absent   → téléchargement (api.swu-db.com/cards/<SET>) + traitement complet du set
 *       - set récent ou incomplet (préventes) → re-téléchargé, seules les nouvelles cartes sont traitées
 *  3. Images : cartes horizontales (Leader, Base) → version "-r" du CDN,
 *     sinon image tournée de -90° et hébergée sur GitHub Pages (Images/<SET>/)
 *  4. Génère SWUCards.json (même format que l'ancien), tokens compris (pris dans les fichiers de set)
 *  5. Aucune carte perdue : un ancien ID absent devient un alias (aliasOf) ou est conservé tel quel
 *  6. Rapport détaillé dans Scripts/update-report.md
 *
 * Emplacement : Scripts/Update_SWU.js (lancé depuis n'importe où, les chemins partent de la racine du repo)
 * Usage       : node Scripts/Update_SWU.js
 * Dépendance  : sharp  (npm install sharp)
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// ─────────────────────────────── Configuration ───────────────────────────────

const CONFIG = {
    apiBase: trimSlash(process.env.API_BASE || 'https://api.swu-db.com'),
    pagesBaseUrl: trimSlash(process.env.PAGES_BASE_URL || 'https://valcur.github.io/TCG-Arena-SWU'),
    repoRoot: path.resolve(process.env.REPO_ROOT || path.join(__dirname, '..')),

    // fichiers du jeu, relatifs à la racine du repo
    cardsFile: 'SWUCards.json',
    setsDir: 'Sets',                       // Sets/SWU_<SET>.json
    setFilePrefix: 'SWU_',
    imagesDir: 'Images',                   // Images/<SET>/<NUMERO>.webp (images tournées localement)

    // fichiers internes, dans le dossier du script
    reportPath: path.join(__dirname, 'update-report.md'),

    // quels sets télécharger
    includeSet: set => set.isBaseSet === true,
    extraSets: [],                         // sets non "base" à ajouter quand même, ex: ['P25']
    excludedSets: [],                      // sets à ignorer, ex: ['IC27']

    excludedVariants: ['Foil', 'Serialized'],               // VariantType contenant un de ces mots → ignoré
    variantPriority: ['Normal', 'Hyperspace', 'Showcase', 'Prestige'], // si deux cartes ont le même ID
    horizontalTypes: ['Leader', 'Base'],   // recto affiché à l'horizontale

    refreshRecentSetsDays: 45,             // set sorti il y a moins de N jours (ou pas encore sorti) → re-téléchargé à chaque run
    checkAllImages: true,                  // vérifie aussi que les images verticales existent (une seule fois par carte)

    concurrency: 6,
    timeoutMs: 30_000,
    retries: 3,
    webpQuality: 90,
    minRatioVsPrevious: 0.8,               // refuse d'écrire si on perd >20% des cartes (FORCE=1 pour forcer)
    userAgent: 'TCG-Arena-SWU-updater (+https://valcur.github.io/TCG-Arena-SWU)',
};

/**
 * Alias forcés à la main pour les anciens IDs : 'ANCIEN_ID': 'NOUVEL_ID'.
 * Sans entrée ici, le script cherche tout seul (même numéro sans zéros, token du même nom, même nom dans le même set).
 */
const ALIAS_OVERRIDES = {
};

// ─────────────────────────────── Rapport d'erreurs ───────────────────────────────

const issues = []; // { level: 'error' | 'warning', category, id, message, details? }

function report(level, category, id, message, details) {
    issues.push({ level, category, id, message, details });
}

class FatalError extends Error { }

// ─────────────────────────────── Utilitaires ───────────────────────────────

function trimSlash(s) { return s.replace(/\/+$/, ''); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rel(...p) { return path.join(CONFIG.repoRoot, ...p); }
function safeFileName(s) { return String(s).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_'); }
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') report('warning', 'Fichiers locaux illisibles (ignorés)', path.relative(CONFIG.repoRoot, file), e.message);
        return fallback;
    }
}

async function writeFileAtomic(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, file);
}

async function runPool(items, limit, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const item = items[i++];
            await worker(item);
        }
    });
    await Promise.all(runners);
}

/** "10/9/26" → Date (UTC) ; null si illisible */
function parseReleaseDate(s) {
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) return null;
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2])));
}

/** Requête HTTP avec retries sur erreurs réseau / 429 / 5xx */
async function httpRequest(url, { method = 'GET', headers = {} } = {}) {
    let lastError = 'erreur inconnue';
    let lastStatus;
    for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
        try {
            const res = await fetch(url, {
                method,
                headers: { 'User-Agent': CONFIG.userAgent, ...headers },
                signal: AbortSignal.timeout(CONFIG.timeoutMs),
            });
            lastStatus = res.status;
            if ([403, 404, 410].includes(res.status)) {
                try { await res.body?.cancel(); } catch { }
                return { notFound: true, status: res.status };
            }
            if (res.status === 429 || res.status >= 500) {
                try { await res.body?.cancel(); } catch { }
                lastError = `HTTP ${res.status}`;
            } else if (!res.ok) {
                try { await res.body?.cancel(); } catch { }
                return { error: `HTTP ${res.status}`, status: res.status };
            } else {
                const buffer = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
                return { ok: true, status: res.status, buffer, contentType: res.headers.get('content-type') || '' };
            }
        } catch (e) {
            lastError = e.name === 'TimeoutError' ? `timeout après ${CONFIG.timeoutMs / 1000}s` : (e.cause?.code || e.message);
        }
        if (attempt < CONFIG.retries) await sleep(1000 * 2 ** (attempt - 1));
    }
    return { error: lastError, status: lastStatus };
}

async function fetchJson(url) {
    const r = await httpRequest(url);
    if (!r.ok) return { error: r.notFound ? `HTTP ${r.status}` : r.error };
    try {
        return { data: JSON.parse(r.buffer.toString('utf8')) };
    } catch (e) {
        return { error: `JSON invalide (${e.message})` };
    }
}

// ─────────────────────────────── Images ───────────────────────────────

const stats = {
    setsDownloaded: [], setsRefreshed: [], setsFromCache: [], cardsProcessed: 0,
    rFound: 0, rotatedLocal: 0, pending: 0,
};

/** ".../HMW/001.png" → ".../HMW/001-r.png" */
function rotatedUrl(url) {
    return url.replace(/(\.[A-Za-z0-9]+)(\?.*)?$/, '-r$1$2');
}

function isImageType(contentType) {
    return !contentType || contentType.startsWith('image/') || contentType.includes('octet-stream');
}

/** Existe-t-il une image à cette URL ? → { state: 'ok' | 'missing' | 'error' } */
async function probeImage(url) {
    let r = await httpRequest(url, { method: 'HEAD' });
    if (r.error && r.status && r.status < 500) r = await httpRequest(url, { headers: { Range: 'bytes=0-1023' } }); // HEAD refusé
    if (r.notFound) return { state: 'missing' };
    if (r.error) return { state: 'error', error: r.error };
    if (!isImageType(r.contentType)) return { state: 'missing', note: `contenu "${r.contentType}"` };
    return { state: 'ok' };
}

function pngSize(b) {
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    return null;
}

/** Dimensions d'une image distante (lit seulement le début du fichier si possible) */
async function imageSize(url) {
    const r = await httpRequest(url, { headers: { Range: 'bytes=0-65535' } });
    if (r.notFound) return { state: 'missing' };
    if (r.error) return { state: 'error', error: r.error };
    if (!isImageType(r.contentType)) return { state: 'missing', note: `contenu "${r.contentType}"` };
    let dims = pngSize(r.buffer);
    if (!dims) {
        try {
            const m = await sharp(r.buffer).metadata();
            if (m.width && m.height) dims = { width: m.width, height: m.height };
        } catch { }
    }
    if (!dims && r.status === 206) {
        const full = await httpRequest(url);
        if (full.ok) {
            try {
                const m = await sharp(full.buffer).metadata();
                if (m.width && m.height) dims = { width: m.width, height: m.height };
            } catch { }
        }
    }
    return dims ? { state: 'ok', ...dims } : { state: 'error', error: 'dimensions illisibles' };
}

/** Télécharge une image, la tourne de -90° si elle est plus large que haute, la sauve dans Images/<SET>/ */
async function downloadRotated(url, setCode, fileBase) {
    const r = await httpRequest(url);
    if (r.notFound) return { state: 'missing' };
    if (r.error) return { state: 'error', error: r.error };
    let meta;
    try {
        meta = await sharp(r.buffer).metadata();
    } catch (e) {
        return { state: 'error', error: `image illisible (${e.message})` };
    }
    if (!(meta.width > meta.height)) return { state: 'portrait', width: meta.width, height: meta.height };

    const relPath = `${safeFileName(setCode)}/${safeFileName(fileBase)}.webp`;
    const out = rel(CONFIG.imagesDir, relPath);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await sharp(r.buffer).rotate(-90).webp({ quality: CONFIG.webpQuality }).toFile(out + '.tmp');
    await fsp.rename(out + '.tmp', out);
    return { state: 'ok', relPath, url: `${CONFIG.pagesBaseUrl}/${CONFIG.imagesDir}/${relPath}`, width: meta.width, height: meta.height };
}

/**
 * Résout les images d'une carte. Retourne l'état stocké dans Sets/SWU_<SET>.json :
 * { front, frontHorizontal, back?, backHorizontal?, local: [chemins], retry: [raisons], srcFront, srcBack }
 * Une carte avec "retry" non vide est retraitée au prochain run (erreur réseau, image absente du CDN...).
 */
async function resolveImages(c, id) {
    const st = {
        front: c.FrontArt || '',
        frontHorizontal: CONFIG.horizontalTypes.includes(c.Type),
        local: [],
        retry: [],
        srcFront: c.FrontArt || '',
    };

    // ── Recto ──
    if (!c.FrontArt) {
        report('error', 'FrontArt manquant dans les données', id, c.Name || '');
    } else if (st.frontHorizontal) {
        const rUrl = rotatedUrl(c.FrontArt);
        const p = await probeImage(rUrl);
        if (p.state === 'ok') {
            st.front = rUrl;
            stats.rFound++;
        } else if (p.state === 'error') {
            st.retry.push(`recto -r : ${p.error}`);
        } else {
            const d = await downloadRotated(c.FrontArt, c.Set, c.Number);
            if (d.state === 'ok') {
                st.front = d.url;
                st.local.push(d.relPath);
                stats.rotatedLocal++;
                report('warning', 'Pas d\'image -r : recto tourné et hébergé sur GitHub Pages', id, `${d.width}x${d.height} → ${CONFIG.imagesDir}/${d.relPath}`);
            } else if (d.state === 'portrait') {
                report('warning', 'Pas d\'image -r mais recto déjà vertical (utilisé tel quel)', id, `${d.width}x${d.height}`);
            } else if (d.state === 'missing') {
                st.retry.push('recto introuvable');
                report('error', 'Image introuvable sur le CDN (retentée à chaque run)', id, `recto : ${c.FrontArt} (ni ${rUrl})`);
            } else {
                st.retry.push(`recto : ${d.error}`);
            }
        }
    } else if (CONFIG.checkAllImages) {
        const p = await probeImage(c.FrontArt);
        if (p.state === 'missing') {
            st.retry.push('recto introuvable');
            report('error', 'Image introuvable sur le CDN (retentée à chaque run)', id, `recto : ${c.FrontArt}${p.note ? ' — ' + p.note : ''}`);
        } else if (p.state === 'error') {
            st.retry.push(`recto : ${p.error}`);
        }
    }

    // ── Verso ──
    if (c.DoubleSided) {
        st.back = c.BackArt || '';
        st.backHorizontal = false;
        st.srcBack = c.BackArt || '';
        if (!c.BackArt) {
            report('error', 'Carte double face sans BackArt', id, c.Name || '');
        } else {
            const s = await imageSize(c.BackArt);
            if (s.state === 'missing') {
                st.retry.push('verso introuvable');
                report('error', 'Image introuvable sur le CDN (retentée à chaque run)', id, `verso : ${c.BackArt}`);
            } else if (s.state === 'error') {
                st.retry.push(`verso : ${s.error}`);
            } else if (s.width > s.height) {
                // verso horizontal (ex: leader avec deux faces leader)
                st.backHorizontal = true;
                const rUrl = rotatedUrl(c.BackArt);
                const p = await probeImage(rUrl);
                if (p.state === 'ok') {
                    st.back = rUrl;
                    stats.rFound++;
                } else if (p.state === 'error') {
                    st.retry.push(`verso -r : ${p.error}`);
                } else {
                    const d = await downloadRotated(c.BackArt, c.Set, `${c.Number}-b`);
                    if (d.state === 'ok') {
                        st.back = d.url;
                        st.local.push(d.relPath);
                        stats.rotatedLocal++;
                        report('warning', 'Verso horizontal : tourné et hébergé sur GitHub Pages', id, `${d.width}x${d.height} → ${CONFIG.imagesDir}/${d.relPath}`);
                    } else if (d.state === 'error') {
                        st.retry.push(`verso : ${d.error}`);
                    }
                }
            }
        }
    }

    const network = st.retry.filter(r => !r.includes('introuvable'));
    if (network.length) {
        stats.pending++;
        report('warning', 'Images non vérifiées (erreur réseau) : retentées au prochain run', id, network.join(' ; '));
    }
    return st;
}

// ─────────────────────────────── Sets ───────────────────────────────

function setFilePath(code) {
    return rel(CONFIG.setsDir, `${CONFIG.setFilePrefix}${safeFileName(code)}.json`);
}

function isTokenCard(c) {
    return /token/i.test(c.Type || '') || /^T\d+$/i.test(String(c.Number || ''));
}

/** Nombre de cartes "Normal" (hors tokens) d'un fichier de set, pour détecter un set incomplet */
function normalCount(raw) {
    return (raw?.data || []).filter(c => (c.VariantType || 'Normal') === 'Normal' && !isTokenCard(c)).length;
}

/** Faut-il re-télécharger un set déjà présent ? (préventes, set tout juste sorti, set incomplet) */
function refreshReason(meta, existing) {
    if (!meta) return null;
    const release = parseReleaseDate(meta.releaseDate);
    if (!release) return 'date de sortie inconnue';
    const ageDays = (Date.now() - release.getTime()) / 86_400_000;
    if (ageDays < 0) return `pas encore sorti (${meta.releaseDate})`;
    if (ageDays < CONFIG.refreshRecentSetsDays) return `sorti il y a ${Math.floor(ageDays)} jour(s)`;
    const n = normalCount(existing);
    if (meta.numberCards && n < meta.numberCards) return `incomplet (${n}/${meta.numberCards} cartes)`;
    return null;
}

function variantRank(v) {
    const i = CONFIG.variantPriority.indexOf(v || 'Normal');
    return i < 0 ? 99 : i;
}

/**
 * Charge (et si besoin télécharge) un set, résout les images des cartes qui ne l'ont pas encore été,
 * réécrit Sets/SWU_<SET>.json si quelque chose a changé.
 * Retourne { code, info, cards: [{ c, id, img }] } ou null.
 */
async function processSet(code, meta) {
    const file = setFilePath(code);
    const existing = await readJsonIfExists(file, null);
    let raw = existing;
    let changed = false;

    const reason = existing ? refreshReason(meta, existing) : 'nouveau';
    if (!existing || reason) {
        if (!meta) {
            report('error', 'Set introuvable dans l\'API et pas de fichier local', code, '');
            return null;
        }
        process.stdout.write(`📥 ${code} (${meta.fullName}) — ${existing ? 're-téléchargé : ' + reason : 'téléchargement'}… `);
        const r = await fetchJson(`${CONFIG.apiBase}/cards/${encodeURIComponent(code)}`);
        if (r.error || !Array.isArray(r.data?.data)) {
            const why = r.error || 'pas de tableau "data"';
            console.log(`❌ ${why}`);
            if (existing) {
                report('warning', 'Re-téléchargement impossible, fichier local utilisé', code, why);
            } else {
                report('error', 'Téléchargement du set impossible (anciennes cartes de ce set conservées)', code, why);
                return null;
            }
        } else {
            raw = r.data;
            changed = true;
            console.log(`${raw.data.length} entrées`);
            (existing ? stats.setsRefreshed : stats.setsDownloaded).push(code);
            if (existing && reason.startsWith('incomplet')) report('warning', 'Sets incomplets (re-téléchargés à chaque run)', code, reason);
        }
    } else {
        stats.setsFromCache.push(code);
    }

    // fichier absent → état vide → tout est retraité
    const prevImages = existing?.tcgArena?.images || {};
    const info = {
        setId: code,
        fullName: meta?.fullName || existing?.tcgArena?.set?.fullName || code,
        releaseDate: meta?.releaseDate || existing?.tcgArena?.set?.releaseDate || null,
    };

    // ── Sélection des cartes ──
    const byId = new Map();
    const excluded = {};
    for (const c of raw.data) {
        if (!c || !c.Set || c.Number == null || c.Number === '') {
            report('error', 'Carte invalide dans les données (ignorée)', code, JSON.stringify(c).slice(0, 150));
            continue;
        }
        const variant = c.VariantType || 'Normal';
        if (CONFIG.excludedVariants.some(x => variant.includes(x))) {
            excluded[variant] = (excluded[variant] || 0) + 1;
            continue;
        }
        if (c.Set !== code) report('warning', 'Carte dont le champ Set diffère du set téléchargé', `${c.Set}_${c.Number}`, `dans ${code}`);
        const id = `${c.Set}_${c.Number}`;
        const prev = byId.get(id);
        if (prev) {
            const keepNew = variantRank(variant) < variantRank(prev.VariantType);
            report('warning', 'Doublons d\'ID (une seule variante gardée)', id, `${prev.VariantType} / ${variant} → ${keepNew ? variant : prev.VariantType} gardée`);
            if (!keepNew) continue;
        }
        byId.set(id, c);
    }
    info.excludedVariants = excluded;

    // ── Images : uniquement les cartes pas encore traitées (ou à retenter) ──
    const images = {};
    const todo = [];
    for (const [id, c] of byId) {
        const st = prevImages[id];
        const stale = !st
            || st.retry?.length
            || st.srcFront !== (c.FrontArt || '')
            || (c.DoubleSided ? st.srcBack !== (c.BackArt || '') : st.back !== undefined)
            || (st.local || []).some(p => !fs.existsSync(rel(CONFIG.imagesDir, p)));
        if (stale) todo.push([id, c]);
        else images[id] = st;
    }
    if (todo.length) {
        console.log(`🖼️  ${code} : ${todo.length} carte(s) à traiter`);
        let done = 0;
        await runPool(todo, CONFIG.concurrency, async ([id, c]) => {
            images[id] = await resolveImages(c, id);
            stats.cardsProcessed++;
            if (++done % 100 === 0) console.log(`   ${done}/${todo.length}`);
        });
        changed = true;
    }
    // cartes disparues d'un set re-téléchargé
    if (Object.keys(prevImages).some(id => !byId.has(id))) changed = true;

    if (changed || !existing?.tcgArena) {
        const sortedImages = Object.fromEntries(Object.keys(images).sort().map(k => [k, images[k]]));
        const { tcgArena, ...rest } = raw;
        await writeFileAtomic(file, JSON.stringify({ ...rest, tcgArena: { set: info, updatedAt: new Date().toISOString(), images: sortedImages } }, null, 2) + '\n');
    }

    return { code, info, cards: [...byId].map(([id, c]) => ({ c, id, img: images[id] })) };
}

// ─────────────────────────────── Format SWUCards.json ───────────────────────────────

function buildCardEntry(c, id, img) {
    const token = isTokenCard(c);
    // "Token Unit" → "Unit", "Token Upgrade" → "Upgrade", "Credit Token" reste tel quel
    const baseType = String(c.Type || 'Unknown').replace(/^Token\s+/i, '');
    const arena = Array.isArray(c.Arenas) && c.Arenas[0] ? c.Arenas[0] : null;
    // unité sans arène dans l'API (ex: tokens Mandalorian, Beast) → Ground par défaut
    const type = baseType === 'Unit' ? `Unit - ${arena || 'Ground'}` : baseType;
    const name = c.Subtitle ? `${c.Name}, ${c.Subtitle}` : String(c.Name || '?');
    const cost = toInt(c.Cost);

    const entry = {
        id,
        face: {
            front: { name, type, cost, image: img?.front ?? c.FrontArt ?? '', isHorizontal: img?.frontHorizontal ?? CONFIG.horizontalTypes.includes(c.Type) },
        },
        name,
        type,
        cost,
        rarity: token ? 'Token' : (c.Rarity || ''),
        power: toInt(c.Power),
        HP: toInt(c.HP),
        set: c.Set,
        aspects: Array.isArray(c.Aspects) ? c.Aspects : [],
        unique: !!c.Unique,
        traits: Array.isArray(c.Traits) ? c.Traits : [],
    };
    if (c.DoubleSided) {
        entry.face.back = { name, type, cost, image: img?.back ?? c.BackArt ?? '', isHorizontal: img?.backHorizontal === true };
    }
    if (token) entry.isToken = true;
    if (baseType === 'Unit' && !arena) report('warning', 'Unités sans arène dans l\'API (mises en "Unit - Ground")', id, name);
    return entry;
}

// ─────────────────────────────── Anciens IDs : alias ou conservation ───────────────────────────────

/** "IBH_002" et "IBH_2" → même clé */
function normalizeId(id) {
    return String(id).toUpperCase().replace(/_0+(\d)/, '_$1');
}

/** Ancien token (T_01…) : ni alias ni conservation, les tokens viennent maintenant des fichiers de set */
function isOldToken(entry) {
    return entry && (entry.isToken === true || entry.rarity === 'Token');
}

/**
 * Pour chaque ancienne carte (hors tokens) absente des nouvelles cartes :
 *  1. ALIAS_OVERRIDES   2. alias déjà existant   3. même ID au format près (zéros)
 *  4. carte du même nom et du même type dans le même set
 *  sinon l'ancienne entrée est conservée telle quelle (aucune carte perdue).
 * Les anciens tokens absents sont simplement retirés.
 */
function resolveOldIds(previousCards, out) {
    const real = Object.keys(out);
    const realSet = new Set(real);
    const byNorm = new Map();
    for (const id of real) byNorm.set(normalizeId(id), [...(byNorm.get(normalizeId(id)) || []), id]);

    const raw = {};     // oldId → { target, how, approx, carried }
    const kept = {};    // oldId → ancienne entrée conservée
    const droppedTokens = [];
    const oldIds = new Set([...Object.keys(previousCards), ...Object.keys(ALIAS_OVERRIDES)]);

    for (const oldId of oldIds) {
        if (realSet.has(oldId)) continue;
        const prev = previousCards[oldId];
        if (ALIAS_OVERRIDES[oldId]) { raw[oldId] = { target: ALIAS_OVERRIDES[oldId], how: 'manuel' }; continue; }
        // alias vers un token (créé par une version précédente du script) → retiré
        if (prev?.aliasOf && out[prev.aliasOf]?.isToken) { droppedTokens.push(oldId); continue; }
        if (prev?.aliasOf) { raw[oldId] = { target: prev.aliasOf, how: 'alias existant', carried: true }; continue; }
        if (!prev) continue;
        if (isOldToken(prev)) { droppedTokens.push(oldId); continue; }

        const same = byNorm.get(normalizeId(oldId)) || [];
        if (same.length === 1) { raw[oldId] = { target: same[0], how: 'même ID (zéros)' }; continue; }

        if (prev.set) {
            const candidates = real.filter(id => out[id].set === prev.set && out[id].name === prev.name && out[id].type === prev.type);
            const normal = candidates.filter(id => out[id]._variantRank === 0);
            const pick = normal.length === 1 ? normal[0] : candidates.length === 1 ? candidates[0] : null;
            if (pick) { raw[oldId] = { target: pick, how: 'même nom dans le même set', approx: true }; continue; }
        }
        kept[oldId] = prev;
    }

    // aplatit les chaînes A→B→C (le moteur ne suit qu'un niveau)
    const aliases = {};
    for (const [oldId, a] of Object.entries(raw)) {
        let target = a.target;
        const seen = new Set([oldId]);
        while (!realSet.has(target) && raw[target] && !seen.has(target)) {
            seen.add(target);
            target = raw[target].target;
        }
        if (realSet.has(target)) aliases[oldId] = { ...a, target };
        else if (previousCards[oldId] && !previousCards[oldId].aliasOf) kept[oldId] = previousCards[oldId];
        else report('warning', 'Alias impossible : la carte cible n\'existe plus', oldId, `cible "${a.target}" (${a.how})`);
    }
    return { aliases, kept, droppedTokens };
}

// ─────────────────────────────── Rapport ───────────────────────────────

function translationSnippet(newCodes) {
    return newCodes.map(c => `        ${JSON.stringify(c.code)}: ${JSON.stringify(c.suggestion)},`).join('\n');
}

function buildReport(summary) {
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    const v = summary.verification;
    const lines = [];
    lines.push(`# Mise à jour des cartes SWU — ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, '');
    lines.push('| | |', '|---|---|');
    lines.push(`| Sets téléchargés | ${stats.setsDownloaded.join(', ') || '—'} |`);
    lines.push(`| Sets re-téléchargés (récents / incomplets) | ${stats.setsRefreshed.join(', ') || '—'} |`);
    lines.push(`| Sets lus depuis Sets/ | ${stats.setsFromCache.join(', ') || '—'} |`);
    lines.push(`| Cartes dans ${CONFIG.cardsFile} | ${summary.cardCount} (avant : ${summary.previousCount}) |`);
    lines.push(`| Nouvelles cartes | ${summary.added.length} |`);
    lines.push(`| Cartes traitées ce run (images) | ${stats.cardsProcessed} |`);
    lines.push(`| Images -r trouvées | ${stats.rFound} |`);
    lines.push(`| Images tournées localement | ${stats.rotatedLocal} |`);
    lines.push(`| Cartes à retenter (erreur réseau) | ${stats.pending} |`);
    lines.push(`| ❌ Erreurs | ${errors.length} |`);
    lines.push(`| ⚠️ Avertissements | ${warnings.length} |`, '');

    if (summary.fatal) lines.push('## 💥 Erreur bloquante', '', summary.fatal, '', `${CONFIG.cardsFile} n'a PAS été modifié.`, '');

    if (v) {
        lines.push('## ✅ Vérification : aucune ancienne carte perdue', '');
        lines.push(`- Anciennes cartes (hors tokens) : **${v.total}**`);
        lines.push(`- Toujours présentes avec le même ID : **${v.direct}**`);
        lines.push(`- Redirigées par alias : **${v.aliased}**`);
        lines.push(`- Introuvables dans l'API, conservées telles quelles : **${v.kept}**`);
        lines.push(`- Perdues : **${v.lost}**`, '');
    }

    if (summary.perSet.length) {
        lines.push('## 📦 Sets', '');
        lines.push('| Set | Nom | Sortie | Cartes gardées | Variantes ignorées |', '|---|---|---|---|---|');
        for (const s of summary.perSet) {
            const ex = Object.entries(s.info.excludedVariants || {}).map(([k, n]) => `${k} ${n}`).join(', ') || '—';
            lines.push(`| ${s.code} | ${s.info.fullName} | ${s.info.releaseDate || '?'} | ${s.count} | ${ex} |`);
        }
        lines.push('');
    }

    if (summary.newCodes.length) {
        lines.push(`## 🌐 Nouveaux codes à traduire (${summary.newCodes.length})`, '');
        lines.push('À coller dans l\'objet `"en"` de translations.json (sets pré-remplis avec le nom de l\'API) :', '');
        lines.push('```json', translationSnippet(summary.newCodes), '```', '');
    }

    const section = (title, list) => {
        if (!list.length) return;
        lines.push(`## ${title} (${list.length})`, '');
        const byCat = new Map();
        for (const i of list) byCat.set(i.category, [...(byCat.get(i.category) || []), i]);
        for (const [cat, items] of byCat) {
            lines.push(`### ${cat} — ${items.length}`, '');
            items.slice(0, 300).forEach(i => lines.push(`- \`${i.id}\` — ${i.message}`));
            if (items.length > 300) lines.push(`- … et ${items.length - 300} autre(s)`);
            lines.push('');
        }
    };
    section('❌ Erreurs', errors);
    section('⚠️ Avertissements', warnings);

    if (summary.newAliases.length) {
        lines.push(`## 🔗 Alias créés ce run (${summary.newAliases.length})`, '');
        summary.newAliases.forEach(a => lines.push(`- \`${a.oldId}\` → \`${a.target}\` (${a.how})`));
        lines.push('');
    }
    if (summary.added.length) {
        lines.push(`## ➕ Nouvelles cartes (${summary.added.length})`, '');
        const bySet = new Map();
        for (const id of summary.added) {
            const s = id.split('_')[0];
            bySet.set(s, [...(bySet.get(s) || []), id]);
        }
        for (const [s, ids] of bySet) lines.push(`- **${s}** (${ids.length}) : ${ids.slice(0, 60).map(i => `\`${i}\``).join(', ')}${ids.length > 60 ? ', …' : ''}`);
        lines.push('');
    }
    return lines.join('\n');
}

async function writeReport(summary) {
    const md = buildReport(summary);
    await writeFileAtomic(CONFIG.reportPath, md);
    if (process.env.GITHUB_STEP_SUMMARY) {
        const limited = md.length > 900_000 ? md.slice(0, 900_000) + '\n\n_(tronqué, voir Scripts/update-report.md)_' : md;
        await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, limited + '\n');
    }
    if (process.env.GITHUB_OUTPUT) {
        const nErr = issues.filter(i => i.level === 'error').length;
        const nWarn = issues.filter(i => i.level === 'warning').length;
        await fsp.appendFile(process.env.GITHUB_OUTPUT, `errors=${nErr}\nwarnings=${nWarn}\n`);
    }
}

function printIssuesToConsole() {
    const print = (icon, list) => {
        const byCat = new Map();
        list.forEach(i => byCat.set(i.category, [...(byCat.get(i.category) || []), i]));
        for (const [cat, items] of byCat) {
            console.log(`\n${icon} ${cat} (${items.length})`);
            items.slice(0, 40).forEach(i => console.log(`   - ${i.id} : ${i.message}`));
            if (items.length > 40) console.log(`   … et ${items.length - 40} autre(s), voir le rapport`);
        }
    };
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    if (errors.length) { console.log(`\n════════ ❌ ${errors.length} ERREUR(S) ════════`); print('❌', errors); }
    if (warnings.length) { console.log(`\n════════ ⚠️  ${warnings.length} AVERTISSEMENT(S) ════════`); print('⚠️ ', warnings); }
    if (!errors.length && !warnings.length) console.log('\n✨ Aucune erreur, aucun avertissement.');
}

// ─────────────────────────────── Main ───────────────────────────────

async function main() {
    const summary = {
        cardCount: 0, previousCount: 0, added: [], newAliases: [], newCodes: [], perSet: [],
        verification: null, fatal: null,
    };

    try {
        const cardsPath = rel(CONFIG.cardsFile);
        const previousCards = await readJsonIfExists(cardsPath, {});
        summary.previousCount = Object.values(previousCards).filter(c => !c?.aliasOf).length;

        // ── Liste des sets ──
        console.log(`📋 Liste des sets : ${CONFIG.apiBase}/sets`);
        const setsRes = await fetchJson(`${CONFIG.apiBase}/sets`);
        let apiSets = [];
        if (setsRes.error || !Array.isArray(setsRes.data)) {
            report('error', 'Liste des sets inaccessible (seuls les fichiers de Sets/ sont utilisés)', 'sets', setsRes.error || 'réponse inattendue');
        } else {
            apiSets = setsRes.data.filter(s => s && s.setId);
        }
        const metaByCode = new Map(apiSets.map(s => [s.setId, s]));
        const wanted = apiSets
            .filter(s => (CONFIG.includeSet(s) || CONFIG.extraSets.includes(s.setId)) && !CONFIG.excludedSets.includes(s.setId))
            .map(s => s.setId);

        // fichiers déjà présents dans Sets/ (même si le set n'est plus listé par l'API)
        const local = (await fsp.readdir(rel(CONFIG.setsDir)).catch(() => []))
            .map(f => f.match(new RegExp(`^${CONFIG.setFilePrefix}(.+)\\.json$`))?.[1])
            .filter(code => code && !CONFIG.excludedSets.includes(code));
        for (const code of local) {
            if (!metaByCode.has(code) && apiSets.length) report('warning', 'Set présent dans Sets/ mais absent de l\'API (fichier local utilisé)', code, '');
        }

        const codes = [...new Set([...wanted, ...local])];
        const releaseOf = code => parseReleaseDate(metaByCode.get(code)?.releaseDate)?.getTime() ?? Infinity;
        codes.sort((a, b) => releaseOf(a) - releaseOf(b) || a.localeCompare(b));
        console.log(`   ${codes.length} set(s) : ${codes.join(', ')}\n`);

        // ── Traitement des sets ──
        const results = [];
        for (const code of codes) {
            const r = await processSet(code, metaByCode.get(code));
            if (r) results.push(r);
        }
        if (!results.length) throw new FatalError('Aucun set exploitable');

        // ── Construction des cartes ──
        const out = {};
        for (const r of results) {
            const sorted = [...r.cards].sort((a, b) => {
                const ta = isTokenCard(a.c), tb = isTokenCard(b.c);
                if (ta !== tb) return ta ? 1 : -1;
                return toInt(String(a.c.Number).replace(/\D/g, '')) - toInt(String(b.c.Number).replace(/\D/g, '')) || String(a.c.Number).localeCompare(String(b.c.Number));
            });
            for (const { c, id, img } of sorted) {
                if (out[id]) {
                    report('warning', 'Doublons d\'ID entre deux sets (première occurrence gardée)', id, `${out[id].set} / ${r.code}`);
                    continue;
                }
                out[id] = buildCardEntry(c, id, img);
                Object.defineProperty(out[id], '_variantRank', { value: variantRank(c.VariantType), enumerable: false });
            }
            summary.perSet.push({ code: r.code, info: r.info, count: r.cards.length });
        }

        const realIds = Object.keys(out);
        if (summary.previousCount && realIds.length < summary.previousCount * CONFIG.minRatioVsPrevious && process.env.FORCE !== '1') {
            throw new FatalError(`Seulement ${realIds.length} cartes contre ${summary.previousCount} dans le ${CONFIG.cardsFile} actuel. ` +
                'Probable problème côté API. Relancer avec FORCE=1 pour écraser quand même.');
        }
        summary.added = realIds.filter(id => !(id in previousCards));

        // ── Codes de set / rareté nouveaux → translations.json ──
        const known = new Set(Object.values(previousCards).flatMap(c => [c?.set, c?.rarity]).filter(Boolean));
        for (const field of ['set', 'rarity']) {
            for (const id of realIds) {
                const code = out[id][field];
                if (!code || known.has(code)) continue;
                known.add(code);
                summary.newCodes.push({ code, suggestion: field === 'set' ? (metaByCode.get(code)?.fullName || '') : '' });
            }
        }

        // ── Anciens IDs ──
        const { aliases, kept, droppedTokens } = resolveOldIds(previousCards, out);
        // anciennes cartes à vérifier : hors alias et hors tokens retirés
        const oldReal = Object.keys(previousCards).filter(id => !previousCards[id]?.aliasOf && !droppedTokens.includes(id));
        if (droppedTokens.length) {
            report('warning', 'Anciens tokens retirés (remplacés par les tokens des fichiers de set)', droppedTokens.join(', '), `${droppedTokens.length} entrée(s)`);
        }
        for (const [oldId, a] of Object.entries(aliases)) {
            out[oldId] = { id: oldId, aliasOf: a.target };
            if (!a.carried && a.approx) report('warning', 'Alias approximatifs (vérifie que c\'est la bonne carte)', oldId, `→ ${a.target} (${a.how})`);
        }
        for (const [oldId, entry] of Object.entries(kept)) {
            out[oldId] = entry;
            report('warning', 'Anciennes cartes introuvables dans l\'API : conservées telles quelles', oldId, `${entry.name || ''} — ajoute un alias dans ALIAS_OVERRIDES si tu connais la nouvelle carte`);
        }
        summary.newAliases = Object.entries(aliases).filter(([, a]) => !a.carried).map(([oldId, a]) => ({ oldId, ...a }));
        summary.verification = {
            total: oldReal.length,
            direct: oldReal.filter(id => realIds.includes(id)).length,
            aliased: oldReal.filter(id => aliases[id]).length,
            kept: oldReal.filter(id => kept[id]).length,
            lost: oldReal.filter(id => !out[id]).length,
        };

        // ── Écriture ──
        await writeFileAtomic(cardsPath, JSON.stringify(out, null, 2) + '\n');
        summary.cardCount = realIds.length + Object.keys(kept).length;

        const v = summary.verification;
        console.log(`\n💾 ${CONFIG.cardsFile} écrit : ${summary.cardCount} cartes (${summary.added.length} nouvelles, ${Object.keys(kept).length} ancienne(s) conservée(s)) + ${Object.keys(aliases).length} alias`);
        if (v.total) console.log(`✅ Anciennes cartes (hors tokens) : ${v.total} → ${v.direct} identiques, ${v.aliased} via alias, ${v.kept} conservées, ${v.lost} perdue(s)`);
    } catch (e) {
        summary.fatal = e instanceof FatalError ? e.message : `Erreur inattendue : ${e.stack || e.message}`;
        console.error(`\n💥 ${summary.fatal}`);
    }

    printIssuesToConsole();
    if (summary.newCodes.length) {
        console.log(`\n🌐 ${summary.newCodes.length} nouveau(x) code(s) à traduire — à coller dans "en" de translations.json :\n`);
        console.log(translationSnippet(summary.newCodes));
    }
    await writeReport(summary).catch(e => console.error('Impossible d\'écrire le rapport :', e.message));
    console.log(`\n📄 Rapport : ${path.relative(CONFIG.repoRoot, CONFIG.reportPath)}`);
    if (summary.fatal) process.exitCode = 1;
}

main();
