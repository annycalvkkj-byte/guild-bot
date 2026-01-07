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

// --- CONFIGURAÇÃO DO BOT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- CONEXÃO BANCO DE DADOS ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Conectado"))
    .catch(err => console.error("❌ Erro MongoDB:", err));

// --- MODELOS DE DADOS ---
const User = mongoose.model('User', new mongoose.Schema({
    discordId: String,
    username: String,
    ffNick: String,
    ffId: String,
    lastMessage: { type: Date, default: Date.now }
}));

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({
    guildId: String,
    roleNovato: String,
    roleVerificado1: String,
    roleVerificado2: String,
    canalAviso: String,
    msgGuerra: { type: String, default: "@everyone ⚔️ A GUERRA DE GUILDA COMEÇOU!" }
}));

// --- LÓGICA DO BOT ---

client.on('ready', () => {
    console.log(`🤖 Bot online: ${client.user.tag}`);
});

// Registrar atividade e comando de Setup
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    // Atualiza última mensagem para o sistema de inatividade
    await User.findOneAndUpdate(
        { discordId: msg.author.id },
        { lastMessage: new Date(), username: msg.author.username },
        { upsert: true }
    );

    // Comando para criar o botão de verificação
    if (msg.content === '!setup' && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const row = new ActionRowBuilder().addComponents(
            { type: 2, label: 'Verificar-se na Guilda', style: 1, customId: 'btn_verificar' }
        );
        const embed = new EmbedBuilder()
            .setTitle("🛡️ Registro de Membros")
            .setDescription("Clique no botão abaixo para registrar seu ID e Nick e liberar seu acesso.")
            .setColor("#5865F2");

        msg.channel.send({ embeds: [embed], components: [row] });
    }
});

// Interações (Botão e Modal)
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId === 'btn_verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Dados do Free Fire');
        
        const nickInput = new TextInputBuilder()
            .setCustomId('nick').setLabel("Nick no FF").setStyle(TextInputStyle.Short).setRequired(true);
        const idInput = new TextInputBuilder()
            .setCustomId('ffid').setLabel("Seu ID (UID)").setStyle(TextInputStyle.Short).setRequired(true);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(nickInput),
            new ActionRowBuilder().addComponents(idInput)
        );
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'modal_ff') {
        const nick = interaction.fields.getTextInputValue('nick');
        const ffid = interaction.fields.getTextInputValue('ffid');
        const config = await GuildConfig.findOne({ guildId: interaction.guild.id });

        try {
            // Mudar Nick
            await interaction.member.setNickname(nick).catch(() => console.log("Erro ao mudar nick"));

            // Gerenciar Cargos do Site
            if (config) {
                if (config.roleNovato) await interaction.member.roles.remove(config.roleNovato).catch(() => {});
                if (config.roleVerificado1) await interaction.member.roles.add(config.roleVerificado1).catch(() => {});
                if (config.roleVerificado2) await interaction.member.roles.add(config.roleVerificado2).catch(() => {});
            }

            // Criar/Dar cargo de UID
            const roleName = `UID: ${ffid}`;
            let roleUID = interaction.guild.roles.cache.find(r => r.name === roleName);
            if (!roleUID) {
                roleUID = await interaction.guild.roles.create({ name: roleName, reason: 'Verificação FF' });
            }
            await interaction.member.roles.add(roleUID);

            // Salvar no Banco
            await User.findOneAndUpdate(
                { discordId: interaction.user.id },
                { ffNick: nick, ffId: ffid, username: interaction.user.username, lastMessage: new Date() },
                { upsert: true }
            );

            await interaction.reply({ content: "✅ Registro concluído com sucesso!", ephemeral: true });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: "❌ Erro ao aplicar cargos. Verifique a hierarquia do bot.", ephemeral: true });
        }
    }
});

// Aviso de Guerra Sábado 16h
cron.schedule('0 16 * * 6', async () => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if (config && config.canalAviso) {
        const channel = client.channels.cache.get(config.canalAviso);
        if (channel) channel.send(config.msgGuerra || "@everyone ⚔️ Guerra Iniciada!");
    }
}, { timezone: "America/Sao_Paulo" });

// --- SERVIDOR WEB ---
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'ff_secret_key',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Rotas do Site
app.get('/', (req, res) => {
    res.render('login');
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/dashboard');
});

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return res.send("Bot fora do servidor.");

    const dbUsers = await User.find();
    
    // Lista membros cruzando Banco + Discord
    const members = await Promise.all(dbUsers.map(async (u) => {
        const discordMember = await guild.members.fetch(u.discordId).catch(() => null);
        return {
            name: discordMember ? discordMember.user.tag : u.username,
            avatar: discordMember ? discordMember.user.displayAvatarURL() : 'https://cdn.discordapp.com/embed/avatars/0.png',
            ffNick: u.ffNick,
            ffId: u.ffId,
            lastMessage: u.lastMessage
        };
    }));

    res.render('dashboard', { members });
});

app.get('/settings', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    const roles = guild.roles.cache.filter(r => r.name !== "@everyone").map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    
    let config = await GuildConfig.findOne({ guildId: guild.id });
    if (!config) config = {};

    res.render('settings', { roles, channels, config });
});

app.post('/save', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send("Não autorizado");

    await GuildConfig.findOneAndUpdate(
        { guildId: process.env.GUILD_ID },
        { 
            roleNovato: req.body.roleNovato || null,
            roleVerificado1: req.body.roleVerificado1 || null,
            roleVerificado2: req.body.roleVerificado2 || null,
            canalAviso: req.body.canalAviso || null,
            msgGuerra: req.body.msgGuerra
        },
        { upsert: true }
    );

    res.redirect('/settings');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Site rodando na porta ${PORT}`));

client.login(process.env.TOKEN);
