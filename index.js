require('dotenv').config();
const { 
    Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, 
    TextInputStyle, ActionRowBuilder, PermissionsBitField, EmbedBuilder 
} = require('discord.js');
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ MongoDB Conectado"));

// MODELOS
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String, username: String, ffNick: String, ffId: String, lastMessage: { type: Date, default: Date.now }
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String,
    roleNovato: String,
    roleVerificado1: String,
    roleVerificado2: String,
    canalAviso: String,
    canalVerificacao: String, // NOVO: Canal onde o botão de registro vai aparecer
    msgGuerra: { type: String, default: "@everyone ⚔️ A GUERRA DE GUILDA COMEÇOU!" }
}));

// EVENTOS DO BOT
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    await User.findOneAndUpdate({ discordId: msg.author.id }, { lastMessage: new Date(), username: msg.author.username }, { upsert: true });
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId === 'btn_verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Dados do Free Fire');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nick').setLabel("Nick no FF").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ffid').setLabel("Seu ID (UID)").setStyle(TextInputStyle.Short).setRequired(true))
        );
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_ff') {
        const nick = interaction.fields.getTextInputValue('nick');
        const ffid = interaction.fields.getTextInputValue('ffid');
        const config = await GuildConfig.findOne({ guildId: interaction.guild.id });

        try {
            await interaction.member.setNickname(nick).catch(() => {});
            if (config) {
                if (config.roleNovato) await interaction.member.roles.remove(config.roleNovato).catch(() => {});
                if (config.roleVerificado1) await interaction.member.roles.add(config.roleVerificado1).catch(() => {});
                if (config.roleVerificado2) await interaction.member.roles.add(config.roleVerificado2).catch(() => {});
            }
            const roleName = `UID: ${ffid}`;
            let roleUID = interaction.guild.roles.cache.find(r => r.name === roleName);
            if (!roleUID) roleUID = await interaction.guild.roles.create({ name: roleName });
            await interaction.member.roles.add(roleUID);

            await User.findOneAndUpdate({ discordId: interaction.user.id }, { ffNick: nick, ffId: ffid, username: interaction.user.username }, { upsert: true });
            await interaction.reply({ content: "✅ Verificado!", ephemeral: true });
        } catch (e) {
            await interaction.reply({ content: "Erro de permissão! O cargo do bot deve estar no topo.", ephemeral: true });
        }
    }
});

// CRON - GUERRA SÁBADO 16H
cron.schedule('0 16 * * 6', async () => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if (config?.canalAviso) {
        const channel = client.channels.cache.get(config.canalAviso);
        if (channel) channel.send(config.msgGuerra);
    }
}, { timezone: "America/Sao_Paulo" });

// SERVIDOR WEB
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'guild_ff_key', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI, scope: ['identify']
}, (a, b, p, d) => d(null, p)));
passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((o, d) => d(null, o));

app.get('/', (req, res) => res.render('login'));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return res.send("Bot fora do servidor.");
    const dbUsers = await User.find();
    const members = await Promise.all(dbUsers.map(async (u) => {
        const m = await guild.members.fetch(u.discordId).catch(() => null);
        return { name: m ? m.user.tag : u.username, avatar: m ? m.user.displayAvatarURL() : '', ffNick: u.ffNick, ffId: u.ffId, lastMessage: u.lastMessage };
    }));
    res.render('dashboard', { members });
});

app.get('/settings', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const roles = guild.roles.cache.filter(r => r.name !== "@everyone").map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID }) || {};
    res.render('settings', { roles, channels, config });
});

app.post('/save', async (req, res) => {
    await GuildConfig.findOneAndUpdate({ guildId: process.env.GUILD_ID }, req.body, { upsert: true });
    res.redirect('/settings');
});

// ROTA PARA MANDAR O BOTÃO PELO SITE
app.post('/send-setup', async (req, res) => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if (!config?.canalVerificacao) return res.send("Escolha o canal de verificação primeiro!");
    
    const channel = client.channels.cache.get(config.canalVerificacao);
    if (channel) {
        const row = new ActionRowBuilder().addComponents({ type: 2, label: 'Verificar-se na Guilda', style: 1, customId: 'btn_verificar' });
        const embed = new EmbedBuilder().setTitle("🛡️ Registro").setDescription("Clique abaixo para registrar seu ID.").setColor("#5865F2");
        await channel.send({ embeds: [embed], components: [row] });
        res.send("<script>alert('Botão enviado ao canal!'); window.location.href='/settings';</script>");
    } else {
        res.send("Canal não encontrado!");
    }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Online"));
client.login(process.env.TOKEN);
