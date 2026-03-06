# How to add a new set ?

- Get the new set card data on https://api.swu-db.com/cards/"SET_CODE" (copy all the data)
- Add a new file in Sets/ called SWU_"SET_CODE".json and paste all the data in this file
- Add your file name to the list of set files in Script_SWU.js (array called "files" at th the bottom of the script)
- Run the script. SWUCards.json should now be updated
