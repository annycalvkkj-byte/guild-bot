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

// Modelos de Dados
const User = require('./models/User');
const GuildConfig = require('./models/GuildConfig');

// --- INICIALIZAÇÃO DO BOT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ]
});

// --- CONEXÃO MONGODB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Banco de Dados conectado!"))
    .catch(err => console.error("❌ Erro ao conectar banco:", err));

// --- LÓGICA DO BOT DISCORD ---

client.on('ready', () => {
    console.log(`🤖 Bot logado como ${client.user.tag}`);
});

// Registrar atividade e Comando de Setup
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Registrar última mensagem para sistema de inatividade
    await User.findOneAndUpdate(
        { discordId: message.author.id },
        { lastMessage: new Date(), username: message.author.username },
        { upsert: true }
    );

    // Comando para criar o botão de verificação no canal
    if (message.content === '!setup' && message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const row = new ActionRowBuilder().addComponents(
            { type: 2, label: 'Verificar Guilda', style: 1, customId: 'btn_verificar' }
        );
        const embed = new EmbedBuilder()
            .setTitle("🛡️ Verificação da Guilda")
            .setDescription("Clique no botão abaixo para preencher seus dados do Free Fire e liberar seu acesso ao servidor.")
            .setColor("#5865F2");

        message.channel.send({ embeds: [embed], components: [row] });
    }
});

// Gerenciar Interações (Botão e Modal)
client.on('interactionCreate', async (interaction) => {
    // Clique no botão
    if (interaction.isButton() && interaction.customId === 'btn_verificar') {
        const modal = new ModalBuilder().setCustomId('modal_ff').setTitle('Dados do Free Fire');
        
        const nickInput = new TextInputBuilder()
            .setCustomId('nick').setLabel("Seu Nick no FF").setStyle(TextInputStyle.Short).setRequired(true);
        const idInput = new TextInputBuilder()
            .setCustomId('ffid').setLabel("Seu ID no FF").setStyle(TextInputStyle.Short).setRequired(true);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(nickInput),
            new ActionRowBuilder().addComponents(idInput)
        );
        await interaction.showModal(modal);
    }

    // Envio do Modal
    if (interaction.isModalSubmit() && interaction.customId === 'modal_ff') {
        const nick = interaction.fields.getTextInputValue('nick');
        const ffid = interaction.fields.getTextInputValue('ffid');
        
        // Buscar configurações da guilda no banco
        const config = await GuildConfig.findOne({ guildId: interaction.guild.id });

        try {
            // 1. Mudar Nick no Discord
            await interaction.member.setNickname(nick).catch(() => console.log("Erro ao mudar nick (Admin?)"));

            // 2. Gerenciar Cargos Baseado nas Configurações do Site
            if (config) {
                if (config.roleNovato) await interaction.member.roles.remove(config.roleNovato).catch(() => {});
                
                let rolesToAdd = [];
                if (config.roleVerificado1) rolesToAdd.push(config.roleVerificado1);
                if (config.roleVerificado2) rolesToAdd.push(config.roleVerificado2);
                
                if (rolesToAdd.length > 0) await interaction.member.roles.add(rolesToAdd).catch(() => {});
            }

            // 3. Criar Cargo de UID (Opcional - Pode chegar ao limite de 250)
            const uidRoleName = `UID: ${ffid}`;
            let roleUID = interaction.guild.roles.cache.find(r => r.name === uidRoleName);
            if (!roleUID) {
                roleUID = await interaction.guild.roles.create({ name: uidRoleName, reason: 'Verificação FF' });
            }
            await interaction.member.roles.add(roleUID);

            // 4. Salvar dados do Membro
            await User.findOneAndUpdate(
                { discordId: interaction.user.id },
                { ffNick: nick, ffId: ffid, lastMessage: new Date() },
                { upsert: true }
            );

            await interaction.reply({ content: `✅ Tudo pronto, **${nick}**! Seus cargos foram aplicados.`, ephemeral: true });

        } catch (error) {
            console.error(error);
            await interaction.reply({ content: "❌ Erro ao processar sua verificação. Fale com um Vice-Líder.", ephemeral: true });
        }
    }
});

// --- AGENDAMENTO (GUERRA DE GUILDA) ---
// Sábado às 16:00
cron.schedule('0 16 * * 6', async () => {
    const config = await GuildConfig.findOne({ guildId: process.env.GUILD_ID });
    if (config && config.canalAviso) {
        const channel = client.channels.cache.get(config.canalAviso);
        if (channel) channel.send(`@everyone ⚔️ **${config.msgGuerra || 'A GUERRA DE GUILDA COMEÇOU!'}**`);
    }
}, { timezone: "America/Sao_Paulo" });

// --- SERVIDOR WEB (DASHBOARD) ---
const app = express();
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'ff_secret_guild_key',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.REDIRECT_URI,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// Rotas do Site
app.get('/', (req, res) => {
    res.send('<h1>Bot Online</h1><a href="/auth/discord">Login via Discord</a>');
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/dashboard');
});

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const users = await User.find();
    res.render('dashboard', { users, user: req.user });
});

app.get('/settings', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return res.send("Bot não encontrado no servidor especificado no .env");

    const roles = guild.roles.cache.filter(r => r.name !== "@everyone").map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name }));
    
    let config = await GuildConfig.findOne({ guildId: guild.id });
    if (!config) config = { guildId: guild.id };

    res.render('settings', { roles, channels, config });
});

app.post('/settings/save', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send("Não autorizado");

    const { roleNovato, roleVerificado1, roleVerificado2, canalAviso, msgGuerra } = req.body;

    await GuildConfig.findOneAndUpdate(
        { guildId: process.env.GUILD_ID },
        { 
            roleNovato: roleNovato === "none" ? null : roleNovato,
            roleVerificado1: roleVerificado1 === "none" ? null : roleVerificado1,
            roleVerificado2: roleVerificado2 === "none" ? null : roleVerificado2,
            canalAviso: canalAviso === "none" ? null : canalAviso,
            msgGuerra: msgGuerra
        },
        { upsert: true }
    );

    res.redirect('/settings?success=true');
});

// Ping para o Render não dormir
app.get('/ping', (req, res) => res.send('Pong!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Site rodando na porta ${PORT}`));

client.login(process.env.TOKEN);
