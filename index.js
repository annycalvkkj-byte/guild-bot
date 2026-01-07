require('dotenv').config();
const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionsBitField } = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

// BANCO DE DADOS
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, username: String, ffNick: String, ffId: String, lastMessage: { type: Date, default: Date.now }
}));
const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String, roleNovato: String, roleVerificado1: String, roleVerificado2: String, canalAviso: String, msgGuerra: String
}));

const client = new Client({ intents: [7796] }); // Intents p/ Guilds, Members, Messages
mongoose.connect(process.env.MONGO_URI);

// BOT LOGIC
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    await User.findOneAndUpdate({ discordId: msg.author.id }, { lastMessage: new Date(), username: msg.author.username }, { upsert: true });
    if (msg.content === '!setup' && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const row = new ActionRowBuilder().addComponents({ type: 2, label: 'Verificar Guilda', style: 1, customId: 'verificar' });
        msg.channel.send({ content: "Clique abaixo para se registrar:", components: [row] });
    }
});

client.on('interactionCreate', async (i) => {
    if (i.isButton() && i.customId === 'verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Registro FF');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nick').setLabel('Nick FF').setStyle(1)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id_ff').setLabel('ID FF').setStyle(1))
        );
        await i.showModal(modal);
    }
    if (i.isModalSubmit() && i.customId === 'modal_ff') {
        const nick = i.fields.getTextInputValue('nick');
        const id_ff = i.fields.getTextInputValue('id_ff');
        const config = await GuildConfig.findOne({ guildId: i.guild.id });
        try {
            await i.member.setNickname(nick);
            if(config?.roleNovato) await i.member.roles.remove(config.roleNovato);
            if(config?.roleVerificado1) await i.member.roles.add(config.roleVerificado1);
            if(config?.roleVerificado2) await i.member.roles.add(config.roleVerificado2);
            const r = await i.guild.roles.create({ name: `UID: ${id_ff}` });
            await i.member.roles.add(r);
            await User.findOneAndUpdate({ discordId: i.user.id }, { ffNick: nick, ffId: id_ff }, { upsert: true });
            i.reply({ content: "✅ Sucesso!", ephemeral: true });
        } catch (e) { i.reply({ content: "Erro de permissão do bot!", ephemeral: true }); }
    }
});

// AVISO SÁBADO 16H
cron.schedule('0 16 * * 6', async () => {
    const c = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if(c?.canalAviso) {
        const chan = client.channels.cache.get(c.canalAviso);
        if(chan) chan.send(c.msgGuerra || "@everyone Guerra iniciada!");
    }
}, { timezone: "America/Sao_Paulo" });

// SITE
const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize()); app.use(passport.session());

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI, scope: ['identify', 'guilds']
}, (a, b, p, d) => d(null, p)));
passport.serializeUser((u, d) => d(null, u)); passport.deserializeUser((o, d) => d(null, o));

app.get('/', (req, res) => res.send('<body style="background:#121212;color:white;display:flex;justify-content:center;align-items:center;height:100vh"><a href="/auth/discord" style="padding:20px;background:#5865F2;color:white;text-decoration:none;border-radius:10px;font-family:sans-serif;font-weight:bold">ENTRAR COM DISCORD</a></body>'));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const users = await User.find();
    res.render('dashboard', { users });
});

app.get('/settings', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID }) || {};
    res.render('settings', { roles, channels, config });
});

app.post('/save', async (req, res) => {
    await GuildConfig.findOneAndUpdate({ guildId: process.env.GUILD_ID }, req.body, { upsert: true });
    res.redirect('/settings?success=true');
});

app.listen(process.env.PORT || 3000, () => console.log("Site ON"));
client.login(process.env.TOKEN);
