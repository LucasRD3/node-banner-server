// server.js (ATUALIZADO PARA VERCEL)

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); 
const app = express();

// --- REMOVIDO: Porta Dinâmica (Não é necessário em Serverless Functions) ---
// const PORT = process.env.PORT || 3000; 

// --- Configuração CORS ---
app.use(cors()); 

// --- 1. CONFIGURAÇÃO DA PASTA DE ARQUIVOS ESTÁTICOS ---
// A pasta 'banners' está no mesmo nível do 'server.js'.
app.use(express.static(path.join(__dirname, 'banners'))); 

// =========================================================================
// === Mapeamento de Banners por Dia da Semana (BannerDoDia) ===
// =========================================================================

/**
 * Mapeia o dia da semana (retornado por new Date().getDay()) para o nome 
 * do arquivo de banner correspondente.
 * * Dias (JavaScript): 0=Domingo, 1=Segunda, 2=Terça, 3=Quarta, 4=Quinta, 5=Sexta, 6=Sábado.
 * * IMPORTANTE: Todos os arquivos agora estão padronizados para a extensão .png.
 * * Eles DEVEM existir na pasta /banners.
 */
const BannerDoDia = {
    0: 'banner_domingo.png',  // Domingo (Day 0)
    1: 'banner_segunda.png',  // Segunda-feira (Day 1)
    2: 'banner_terca.png',    // Terça-feira (Day 2)
    3: 'banner_quarta.png',   // Quarta-feira (Day 3)
    4: 'banner_quinta.png',   // Quinta-feira (Day 4)
    5: 'banner_sexta.png',    // Sexta-feira (Day 5)
    6: 'banner_sabado.png'    // Sábado (Day 6)
};


// --- 2. ROTA API PARA OBTER OS BANNERS ---
// Esta rota retorna: 1. O Banner do Dia (se houver), seguido por 2. Outros Banners Genéricos.
app.get('/api/banners', (req, res) => {
    const bannersDir = path.join(__dirname, 'banners');
    const today = new Date().getDay(); // Obtém o dia atual (0 a 6)
    
    // Nome do arquivo esperado para o dia de hoje
    const bannerFilenameToday = BannerDoDia[today]; 
    // Lista de todos os nomes de banners específicos da semana
    const allDailyBanners = Object.values(BannerDoDia); 
    
    // --- ✅ AJUSTE VERCEL: A URL base é inferida. ---
    // Usar 'req.protocol + '://' + req.get('host')' é a forma correta no ambiente Vercel.
    const baseUrl = req.protocol + '://' + req.get('host');

    fs.readdir(bannersDir, (err, files) => {
        if (err) {
            console.error('Erro ao ler o diretório de banners:', err);
            return res.status(500).json({ error: 'Falha ao carregar banners.' });
        }

        // Variáveis para armazenar as URLs
        let dailyBannerUrl = [];
        const genericBannerUrls = [];

        // 1. Filtra apenas arquivos de imagem válidos
        const imageFiles = files.filter(file => 
            /\.(jpe?g|png|gif|webp)$/i.test(file)
        );

        // 2. Classifica os arquivos
        imageFiles.forEach(file => {
            // A. É o banner que deve ser exibido hoje? (Prioridade 1: Exibe sempre no início)
            if (file === bannerFilenameToday) {
                dailyBannerUrl.push(`${baseUrl}/${file}`);
            } 
            // B. Não é um banner mapeado para NENHUM dia da semana? (Prioridade 2: Banners Genéricos)
            else if (!allDailyBanners.includes(file)) {
                genericBannerUrls.push(`${baseUrl}/${file}`);
            }
            // C. Se for um banner de outro dia (ex: banner_terca.png na segunda), ele é IGUALMENTE IGNORADO.
        });

        // 3. Combina: Banner do Dia (0 ou 1 item) + Outros Banners Genéricos
        const finalBannerUrls = [...dailyBannerUrl, ...genericBannerUrls];

        if (finalBannerUrls.length === 0) {
            console.log("Nenhum banner encontrado ou mapeado para hoje.");
        }

        res.json({ banners: finalBannerUrls });
    });
});

// --- ❌ REMOVIDO: app.listen(). Em Vercel, a função Serverless cuida disso. ---
/*
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta: ${PORT}`);
});
*/

// --- ✅ EXPORTAÇÃO VERCEL: Exporta o aplicativo Express. ---
module.exports = app;