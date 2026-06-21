const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');

if (!fs.existsSync(configPath)) {
  console.error('config.json not found. Copy config.example.json and fill in credentials.');
  process.exit(1);
}

module.exports = JSON.parse(fs.readFileSync(configPath, 'utf8'));
