const fs = require('fs').promises;

// Fonction pour lire et modifier le fichier JSON
async function modifyJsonFile(inputFilePath, outputFilePath, result, isLast) {
    try {
        const data = await fs.readFile("Sets/" + inputFilePath, 'utf8');
        const jsonObject = JSON.parse(data);

        jsonObject.data.forEach((c) => {
            const cardId = c.Set + "_" + c.Number;
            const cardType = c.Type == "Unit" ? "Unit - " + c.Arenas[0] : c.Type;
            const isHorizontal = cardType == "Base" || cardType == "Leader";
            let cardName = c.Name;
            if (c.Subtitle) {
                cardName += ", " + c.Subtitle;
            }

            function getArtUrl(image) {
                if (isHorizontal && !image.includes("github")) {
                    let withoutExtension = image.slice(0, -4);
                    return withoutExtension + "-r.png";
                } else {
                    return image;
                }
            }

            let newCard = {
                id: cardId,
                face: {
                    front: {
                        name: cardName,
                        type: cardType,
                        cost: parseInt(c.Cost ? c.Cost : 0),
                        image: getArtUrl(c.FrontArt),
                        isHorizontal: isHorizontal
                    }
                },
                name: cardName,
                type: cardType,
                cost: parseInt(c.Cost ? c.Cost : 0),
                rarity: c.Rarity,
                power: parseInt(c.Power ? c.Power : 0),
                HP: parseInt(c.HP ? c.HP : 0),
                aspects: c.Aspects ? c.Aspects : [],
                unique: c.Unique ? true : false,
                traits: c.Traits ? c.Traits : []
            };

            if (c.DoubleSided) {
                newCard.face.back = {
                    name: cardName,
                    type: cardType,
                    cost: c.Cost,
                    image: c.BackArt,
                };
                if (["TWI_017", "TWI_274", "TWI_292"].includes(cardId)) {
                    newCard.face.back.isHorizontal = true;
                }
            }

            if (!c.VariantType.includes("Foil") && !c.VariantType.includes("Serialized")) {
                result[cardId] = newCard;
            }
        });

        console.log("File now has " + Object.keys(result).length + " cards");

        if (isLast) {
            await fs.writeFile(outputFilePath, JSON.stringify(result, null, 2), 'utf8');
            console.log('✅ Le fichier JSON final a été sauvegardé sous', outputFilePath);
            console.log("Cards total: " + Object.keys(result).length);
        }
    } catch (err) {
        console.error("Erreur :", err);
    }
}

async function run() {
    const outputFilePath = 'SWUCards.json';

    // Add tokens manually as they are not in the .json
    let res = {
        "T_01": {
            id: "T_01",
            face: {
                front: {
                    name: "Battle droid",
                    type: "Unit - Ground",
                    cost: 0,
                    image: "https://swudb.com/images/cards/TTWI/T01.png",
                    isHorizontal: false
                }
            },
            name: "Battle droid",
            type: "Unit - Ground",
            cost: 0,
            rarity: "Token",
            power: 1,
            HP: 1,
            aspects: ["Villainy"],
            unique: false,
            traits: ["SEPARATIST", "DROID", "TROOPER"],
            isToken: true
        },
        "T_02": {
            id: "T_02",
            face: {
                front: {
                    name: "Clone trooper",
                    type: "Unit - Ground",
                    cost: 0,
                    image: "https://swudb.com/images/cards/TTWI/T02.png",
                    isHorizontal: false
                }
            },
            name: "Clone trooper",
            type: "Unit - Ground",
            cost: 0,
            rarity: "Token",
            power: 2,
            HP: 2,
            aspects: ["Heroism"],
            unique: false,
            traits: ["REPUBLIC", "CLONE", "TROOPER"],
            isToken: true
        },
        "T_03": {
            id: "T_03",
            face: {
                front: {
                    name: "Experience",
                    type: "Upgrade",
                    cost: 0,
                    image: "https://swudb.com/images/cards/GGTS/5.png",
                    isHorizontal: false
                }
            },
            name: "Experience",
            type: "Upgrade",
            cost: 0,
            rarity: "Token",
            power: 0,
            HP: 0,
            aspects: [],
            unique: false,
            traits: ["LEARNED"],
            isToken: true
        },
        "T_04": {
            id: "T_04",
            face: {
                front: {
                    name: "Shield",
                    type: "Upgrade",
                    cost: 0,
                    image: "https://swudb.com/images/cards/GGTS/6.png",
                    isHorizontal: false
                }
            },
            name: "Shield",
            type: "Upgrade",
            cost: 0,
            rarity: "Token",
            power: 0,
            HP: 0,
            aspects: [],
            unique: false,
            traits: ["ARMOR"],
            isToken: true
        },
        "T_05": {
            id: "T_05",
            face: {
                front: {
                    name: "TIE fighter",
                    type: "Unit - Space",
                    cost: 0,
                    image: "https://swudb.com/images/cards/TJTL/T01.png",
                    isHorizontal: false
                }
            },
            name: "TIE fighter",
            type: "Unit - Space",
            cost: 0,
            rarity: "Token",
            power: 1,
            HP: 1,
            aspects: ["Villainy"],
            unique: false,
            traits: ["VEHICLE", "FIGHTER"],
            isToken: true
        },
        "T_06": {
            id: "T_06",
            face: {
                front: {
                    name: "X-Wing",
                    type: "Unit - Space",
                    cost: 0,
                    image: "https://swudb.com/images/cards/TJTL/T02.png",
                    isHorizontal: false
                }
            },
            name: "X-Wing",
            type: "Unit - Space",
            cost: 0,
            rarity: "Token",
            power: 2,
            HP: 2,
            aspects: ["Heroism"],
            unique: false,
            traits: ["VEHICLE", "FIGHTER"],
            isToken: true
        },
        "T_07": {
            id: "T_07",
            face: {
                front: {
                    name: "Spy",
                    type: "Unit - Ground",
                    cost: 0,
                    image: "https://swudb.com/cdn-cgi/image/quality=95/images/cards/TSEC/T01.png",
                    isHorizontal: false
                }
            },
            name: "Spy",
            type: "Unit - Ground",
            cost: 0,
            rarity: "Token",
            power: 0,
            HP: 2,
            aspects: [],
            unique: false,
            traits: ["OFFICIAL"],
            isToken: true
        }
    }

    const files = ["SWU_SOR.json", "SWU_SHD.json", "SWU_TWI.json", "SWU_JTL.json", "SWU_LOF.json", "SWU_IBH.json", "SWU_SEC.json"];

    // Exécution séquentielle
    for (let i = 0; i < files.length; i++) {
        const isLast = i === files.length - 1;
        await modifyJsonFile(files[i], outputFilePath, res, isLast);
    }
}

run();