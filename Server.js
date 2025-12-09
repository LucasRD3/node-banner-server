// server.js (ATUALIZADO COM CHAVE DE ATIVAÇÃO)

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); 
const { DateTime } = require('luxon'); // ✅ Importa Luxon
const app = express();

// --- Configuração CORS ---
app.use(cors()); 

// --- 1. CONFIGURAÇÃO DA PASTA DE ARQUIVOS ESTÁTICOS ---
// A pasta 'banners' está no mesmo nível do 'server.js'.
app.use(express.static(path.join(__dirname, 'banners'))); 

// =========================================================================
// === Mapeamento de Banners por Dia da Semana (BannerDoDia) ===
// =========================================================================

const BannerDoDia = {
    7: 'banner_domingo.png',  // Domingo (Day 7 em Luxon)
    1: 'banner_segunda.png',  // Segunda-feira (Day 1 em Luxon)
    2: 'banner_terca.png',    // Terça-feira (Day 2 em Luxon)
    3: 'banner_quarta.png',   // Quarta-feira (Day 3 em Luxon)
    4: 'banner_quinta.png',   // Quinta-feira (Day 4 em Luxon)
    5: 'banner_sexta.png',    // Sexta-feira (Day 5 em Luxon)
    6: 'banner_sabado.png'    // Sábado (Day 6 em Luxon)
};


// --- 2. ROTA API PARA OBTER OS BANNERS ---
app.get('/api/banners', (req, res) => {
    const bannersDir = path.join(__dirname, 'banners');
    
    // Obtém o dia atual e o banner esperado para manter o debug útil
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday; // 1 (Seg) a 7 (Dom)
    const bannerFilenameToday = BannerDoDia[today]; 

    // =======================================================
    // 🛑 PASSO 1A: CHECAGEM DA VARIÁVEL DE AMBIENTE PARA DESATIVAÇÃO
    // Se BANNERS_ACTIVE for estritamente a string 'false', desativa os banners.
    const isBannersActive = process.env.BANNERS_ACTIVE !== 'false';
    
    if (!isBannersActive) {
        // Retorna um JSON vazio e uma mensagem de debug
        return res.json({ 
            banners: [],
            debug: {
                currentDay: today,
                timezone: 'America/Sao_Paulo',
                expectedBanner: 'DESATIVADO por BANNERS_ACTIVE=false' 
            }
        });
    }
    // =======================================================

    const allDailyBanners = Object.values(BannerDoDia); 
    const baseUrl = req.protocol + '://' + req.get('host');

    fs.readdir(bannersDir, (err, files) => {
        if (err) {
            console.error('Erro ao ler o diretório de banners:', err);
            return res.status(500).json({ error: 'Falha ao carregar banners.' });
        }

        let dailyBannerUrl = [];
        const genericBannerUrls = [];

        // 1. Filtra apenas arquivos de imagem válidos
        const imageFiles = files.filter(file => 
            /\.(jpe?g|png|gif|webp)$/i.test(file)
        );

        // 2. Classifica os arquivos
        imageFiles.forEach(file => {
            // A. É o banner que deve ser exibido hoje?
            if (file === bannerFilenameToday) {
                dailyBannerUrl.push(`${baseUrl}/${file}`);
            } 
            // B. Não é um banner mapeado para NENHUM dia da semana?
            else if (!allDailyBanners.includes(file)) {
                genericBannerUrls.push(`${baseUrl}/${file}`);
            }
        });

        const finalBannerUrls = [...dailyBannerUrl, ...genericBannerUrls];

        if (finalBannerUrls.length === 0) {
            console.log("Nenhum banner encontrado ou mapeado para hoje.");
        }

        res.json({ 
            banners: finalBannerUrls,
            debug: {
                currentDay: today,
                timezone: 'America/Sao_Paulo',
                expectedBanner: bannerFilenameToday || 'Nenhum'
            }
        });
    });
});

module.exports = app;