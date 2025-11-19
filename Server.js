// server.js (ROTA API PARA LISTAR TODOS OS BANNERS)

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); 
const app = express();

// --- Configuração CORS ---
app.use(cors()); 

// --- 1. CONFIGURAÇÃO DA PASTA DE ARQUIVOS ESTÁTICOS ---
// A pasta 'banners' está no mesmo nível do 'server.js'.
// Vercel irá servir esses arquivos estaticamente.
app.use(express.static(path.join(__dirname, 'banners'))); 

// --- 2. ROTA API PARA OBTER OS BANNERS ---
// Esta rota retorna a URL de TODOS os arquivos de imagem na pasta 'banners'.
app.get('/api/banners', (req, res) => {
    const bannersDir = path.join(__dirname, 'banners');
    
    // ✅ AJUSTE VERCEL: A URL base é inferida dinamicamente no ambiente serverless.
    const baseUrl = req.protocol + '://' + req.get('host');

    fs.readdir(bannersDir, (err, files) => {
        if (err) {
            console.error('Erro ao ler o diretório de banners:', err);
            // IMPORTANTE: Este erro pode ocorrer no Vercel se a pasta 'banners'
            // não for reconhecida como parte do pacote da função serverless.
            return res.status(500).json({ error: 'Falha ao carregar banners.' });
        }

        const finalBannerUrls = [];

        // Filtra apenas arquivos de imagem válidos e cria a URL para CADA UM.
        files.forEach(file => {
            // Verifica se é um arquivo de imagem (jpg, jpeg, png, gif, webp, etc.)
            if (/\.(jpe?g|png|gif|webp)$/i.test(file)) {
                // Adiciona a URL completa do banner à lista.
                finalBannerUrls.push(`${baseUrl}/${file}`);
            }
        });

        if (finalBannerUrls.length === 0) {
            console.log("Nenhum banner de imagem encontrado.");
        }

        // Retorna TODOS os banners encontrados.
        res.json(finalBannerUrls);
    });
});

// --- EXPORTAÇÃO PARA O VERCEL (FUNÇÃO SERVERLESS) ---
// O Vercel usará 'app' como o handler principal.
module.exports = app;