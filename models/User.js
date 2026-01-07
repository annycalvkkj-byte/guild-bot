const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    discordId: String,
    username: String,
    ffNick: String,
    ffId: String,
    lastMessage: { type: Date, default: Date.now },
    isMember: { type: Boolean, default: true }
});

module.exports = mongoose.model('User', UserSchema);
