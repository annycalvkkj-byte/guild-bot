const mongoose = require('mongoose');

const GuildConfigSchema = new mongoose.Schema({
    guildId: String,
    roleNovato: { type: String, default: null }, // Cargo para remover
    roleVerificado1: { type: String, default: null }, // Cargo 1 para dar
    roleVerificado2: { type: String, default: null }, // Cargo 2 para dar
    canalAviso: { type: String, default: null },
    msgGuerra: { type: String, default: "@everyone ⚔️ A Guerra começou!" }
});

module.exports = mongoose.model('GuildConfig', GuildConfigSchema);
