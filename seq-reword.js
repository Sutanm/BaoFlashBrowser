// seq-reword.js — GIT_SEQUENCE_EDITOR: pick -> reword
const fs = require('fs');
const todoFile = process.argv[2];
let content = fs.readFileSync(todoFile, 'utf-8');
content = content.replace(/^pick /gm, 'reword ');
fs.writeFileSync(todoFile, content, 'utf-8');
