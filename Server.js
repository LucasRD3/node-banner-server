// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO)

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); 
const app = express();

app.use(express.json()); 
app.use(cors()); 
app.use(express.static(path.join(__dirname, 'banners'))); 

// --- Mapeamento de Banners por Dia da Semana (BannerDoDia) ---
const BannerDoDia = {
    7: 'banner_domingo.png', 1: 'banner_segunda.png', 2: 'banner_terca.png',    
    3: 'banner_quarta.png', 4: 'banner_quinta.png', 5: 'banner_sexta.png',    
    6: 'banner_sabado.png'    
};
const allDailyBanners = Object.values(BannerDoDia); 

// =========================================================================
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (JSONBIN) ===
// =========================================================================

// As URLs dependem das variáveis de ambiente configuradas no Vercel/Ambiente
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}/latest`;
const JSONBIN_WRITE_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;

// Função para buscar o estado de ativação completo no JSON Bin
async function getBannerConfig() {
    // Retorna o fallback padrão caso o JSON Bin não esteja configurado
    const defaultFallback = { specific_banners: {}, daily_banners_active: true };
    
    if (!process.env.JSONBIN_BIN_ID) {
        return defaultFallback;
    }
    
    try {
        // Nota: A rota de leitura direta do JSON Bin é ideal para o Server
        const response = await fetch(JSONBIN_URL);
        const data = await response.json();
        
        // Retorna a configuração ou o fallback seguro
        return data.record ? data.record : defaultFallback; 
    } catch (error) {
        console.error('Falha ao buscar estado de banners no JSON Bin, assumindo ATIVO:', error.message);
        return defaultFallback; 
    }
}

// =========================================================================
// === ROTAS DA API ===
// =========================================================================

// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
app.get('/api/banners', async (req, res) => {
    
    const config = await getBannerConfig();
    const isDailyActive = config.daily_banners_active;
    const specificStatuses = config.specific_banners || {}; 
    
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday; 
    const bannerFilenameToday = BannerDoDia[today]; 
    const bannersDir = path.join(__dirname, 'banners');
    const baseUrl = req.protocol + '://' + req.get('host');
    let finalBannerUrls = [];

    fs.readdir(bannersDir, (err, files) => {
        if (err) {
            console.error('Erro ao ler o diretório de banners:', err);
            return res.status(500).json({ error: 'Falha ao carregar banners.' });
        }

        const imageFiles = files.filter(file => /\.(jpe?g|png|gif|webp)$/i.test(file));
        
        // 1. Processa Banner do Dia
        if (isDailyActive && bannerFilenameToday) {
             const dailyBannerUrl = imageFiles
                .filter(file => file === bannerFilenameToday)
                .map(file => `${baseUrl}/${file}`);
            finalBannerUrls.push(...dailyBannerUrl);
        }

        // 2. Processa Banners Genéricos e Aleatórios (Qualquer outro arquivo)
        imageFiles.forEach(file => {
            if (!allDailyBanners.includes(file)) { // Se NÃO for um banner diário
                // O banner é considerado ativo se NÃO estiver explícito como false na config
                const isActive = specificStatuses[file] !== false; 
                
                if (isActive) {
                    finalBannerUrls.push(`${baseUrl}/${file}`);
                }
            }
        });
        
        res.json({ 
            banners: [...new Set(finalBannerUrls)],
            // Informações de debug/status podem ser úteis
            debug: {
                currentDay: today,
                timezone: 'America/Sao_Paulo',
                bannerDia: isDailyActive ? bannerFilenameToday : 'DESATIVADO',
                numGenericosAtivos: finalBannerUrls.length - (isDailyActive && finalBannerUrls.includes(`${baseUrl}/${bannerFilenameToday}`) ? 1 : 0)
            }
        });
    });
});

// --- ROTA 2: API PARA OBTER LISTA COMPLETA DE BANNERS E STATUS (PAINEL) ---
app.get('/api/config/banners/list', async (req, res) => {
    const bannersDir = path.join(__dirname, 'banners');
    const config = await getBannerConfig(); // Busca a configuração do JSON Bin

    fs.readdir(bannersDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Falha ao listar banners.' });
        }

        const imageFiles = files.filter(file => /\.(jpe?g|png|gif|webp)$/i.test(file));
        const specificStatuses = config.specific_banners || {};
        
        const bannerList = imageFiles.map(file => {
            const isDaily = allDailyBanners.includes(file);
            let isActive;
            
            if (isDaily) {
                // Para banners diários, o status reflete o controle global
                isActive = config.daily_banners_active !== false; 
            } else {
                // Para banners genéricos, o status reflete o controle individual
                isActive = specificStatuses[file] !== false; 
            }

            return {
                fileName: file,
                isDailyBanner: isDaily,
                isActive: isActive
            };
        });

        res.json({
            config: {
                daily_banners_active: config.daily_banners_active
            },
            banners: bannerList
        });
    });
});

// --- ROTA 3: API PARA ATUALIZAR CONFIGURAÇÃO (ESCRITA DO PAINEL) ---
app.put('/api/config/banners', async (req, res) => {
    
    // Espera { "file": "nome_do_arquivo.png" | "daily", "active": true | false }
    const { file, active } = req.body; 
    
    if (typeof active !== 'boolean' || !file) {
        return res.status(400).json({ success: false, error: 'O campo "active" deve ser booleano e "file" deve ser fornecido.' });
    }

    const url = JSONBIN_WRITE_URL; 
    const apiKey = process.env.JSONBIN_MASTER_KEY; 
    
    try {
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };

        if (file === 'daily') {
            // Se o alvo é o controle global do dia
            newConfig.daily_banners_active = active;
            
        } else {
            // Se o alvo é um banner específico (aleatório/genérico)
            newConfig.specific_banners = newConfig.specific_banners || {};
            
            if (active === true) {
                 // Para ativar, remove a chave, confiando que o Server.js usará o padrão 'true'
                 delete newConfig.specific_banners[file];
            } else {
                 // Para desativar, define explicitamente a chave como 'false'
                 newConfig.specific_banners[file] = false;
            }
        }

        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': apiKey 
            },
            body: JSON.stringify(newConfig) 
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Falha ao atualizar JSON Bin. Status: ${response.status}. Body: ${errorBody}`);
        }

        res.json({ success: true, new_state: active, banner_file: file, message: `Estado do banner ${file} atualizado com sucesso.` });
    } catch (error) {
        console.error('Erro de escrita no JSON Bin:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

module.exports = app;