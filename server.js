
require('dotenv').config();
const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const app = express();
app.use(express.json());

// Config
const PORT = process.env.PORT || 3000;

// Realworks config
const RW_BASE = process.env.REALWORKS_API_BASE;
const RW_TOKEN = 'rwauth ' + process.env.REALWORKS_API_TOKEN;
const RW_AFDELINGSCODE = process.env.REALWORKS_AFDELINGSCODE;

// WhatsApp config
const WA_VERSION = process.env.WHATSAPP_API_VERSION;
const WA_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Overige instellingen
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD || 80);

// ----------------------------------------------------
// 1️⃣ WhatsApp webhook verificatie (Meta callback)
// ----------------------------------------------------
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook geverifieerd');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// ----------------------------------------------------
// 2️⃣ Realworks webhook ontvangen
// ----------------------------------------------------

app.post('/realworks', async (req, res) => {
  console.log('\n🏠 Realworks webhook ontvangen');
  console.log(JSON.stringify(req.body, null, 2));

  const { objectUrl } = req.body;
  if (!objectUrl) {
    console.log('❌ Geen objectUrl in webhook');
    return res.sendStatus(200);
  }

  try {
    const response = await fetch(objectUrl, {
      headers: {
        Authorization: RW_TOKEN,
        Accept: 'application/json',
      },
    });

    console.log('🌐 Realworks response status:', response.status);

    const woningRaw = await response.json();
    console.log('🔍 Raw woning van Realworks:');
    console.log(JSON.stringify(woningRaw, null, 2));
    console.log("🔗 Realworks links:", JSON.stringify(woningRaw.links, null, 2));
console.log('🗝️ Top-level keys in woningRaw:', Object.keys(woningRaw));

// Specifiek de velden waar vaak documenten zitten:
console.log('📂 woningRaw.documenten:', JSON.stringify(woningRaw.documenten, null, 2));
console.log('📂 woningRaw.media:', JSON.stringify(woningRaw.media, null, 2));

// Als je wilt nog wat extra gokjes:
console.log('📂 woningRaw.diversen:', JSON.stringify(woningRaw.diversen, null, 2));

    const woning = mapRealworksObjectToInternalModel(woningRaw);
    console.log('📦 Gemapte woning:', woning);
console.log('📑 brochureUrl in woning:', woning.brochureUrl);
    const matches = vindMatchesVoorWoning(woning);
    console.log(`🎯 ${matches.length} matches gevonden`);

    for (const match of matches) {
      await sendWhatsAppAanbod(match.zoekprofiel, woning);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Fout:', err);
    res.sendStatus(500);
  }
});

// ----------------------------------------------------
function mapRealworksObjectToInternalModel(rw) {
  const adres = rw.adres || {};
  const algemeen = rw.algemeen || {};
  const detail = rw.detail || {};
  const buiten = detail.buitenruimte || {};
  const financieel = (rw.financieel && rw.financieel.overdracht) || {};
  const diversen = (rw.diversen && rw.diversen.diversen) || {};
  const objectType = (rw.object && rw.object.type) || {};

  // 🏡 Huisnummer mooi samenvoegen: "242 B"
  const huisnummerStr = `${adres.huisnummer || ''}${
    adres.huisnummertoevoeging ? ' ' + adres.huisnummertoevoeging : ''
  }`.trim();

  // 🖼 Hoofdfoto uit media[]
  let imageUrl = null;
  if (Array.isArray(rw.media)) {
    const hoofd = rw.media.find((m) => m.soort === 'HOOFDFOTO' && m.link);
    if (hoofd) {
      imageUrl = hoofd.link;
    }
  }

  // 🌳 Simpele indicatie buitenruimte
  let buitenruimte = '';
  if (Array.isArray(buiten.tuintypes) && buiten.tuintypes.length > 0) {
    buitenruimte = 'TUIN';
  } else if ((buiten.oppervlakteGebouwgebondenBuitenruimte || 0) > 0) {
    buitenruimte = 'BALKON';
  }

  // 💶 Vraagprijs (koopprijs als die er is, anders transactiewaarde)
  const vraagprijs = Number(financieel.koopprijs || financieel.transactieprijs || 0);

  // -----------------------------
  // 📄 Brochure zoeken in media
  // -----------------------------
  const media = Array.isArray(rw.media) ? rw.media : [];

  // 1. Eerst een vrijgegeven DOCUMENT-pdf
  let brochureDoc = media.find((item) => {
    if (!item) return false;
    return (
      item.soort === 'DOCUMENT' &&
      item.mimetype === 'application/pdf' &&
      item.vrijgave === true
    );
  });

  // 2. Zo niet: pak gewoon de eerste DOCUMENT-pdf
  if (!brochureDoc) {
    brochureDoc = media.find((item) => {
      if (!item) return false;
      return (
        item.soort === 'DOCUMENT' &&
        item.mimetype === 'application/pdf'
      );
    });
  }

  let brochureUrl = null;
  if (brochureDoc && brochureDoc.link) {
    brochureUrl = brochureDoc.link;
  }

  console.log('📑 Gevonden brochureDoc:', brochureDoc);
  console.log('🔗 Afgeleide brochureUrl:', brochureUrl);

  // -----------------------------
  // Teruggeven in jouw interne vorm
  // -----------------------------
  return {
    id: diversen.objectcode || rw.id || null,
    straat: adres.straat || null,
    huisnummer: huisnummerStr,
    plaats: adres.plaats || null,
    postcode: adres.postcode || null,
    vraagprijs,
    kamers: Number(algemeen.aantalKamers || 0),
    woonoppervlakte: Number(algemeen.woonoppervlakte || 0),
    energielabel: algemeen.energieklasse || null,
    buitenruimte,
    objectsoort: objectType.objecttype || algemeen.woonhuissoort || 'woning',
    appartementsoort: algemeen.appartementsoort || null,
    fundaUrl: null,
    imageUrl,
    brochureUrl
  };
}

// ----------------------------------------------------
// 4️⃣ Simpele zoekprofielen (tijdelijk hardcoded)
// ----------------------------------------------------
const zoekprofielen = [
  {
    id: 1,
    zoekerNaam: 'Fenna Test',
    telefoon: '0613185813',
    whatsappOptIn: true,
    harde: {
      plaatsen: ['Schiedam', 'Vlaardingen', 'Rotterdam'],
      prijsMin: 250000,
      prijsMax: 500000,
      type: ['Appartement', 'Eengezinswoning']
    },
    zachte: {
      minKamers: 3,
      minM2: 70,
      energielabelMin: 'C',
      buitenruimte: true
    }
  }
];

// ----------------------------------------------------
// 5️⃣ Matching-logica
// ----------------------------------------------------
function normalize(str) {
  return (str || '').toString().trim().toUpperCase();
}

function voldoetAanHardeWensen(woning, harde) {
  // Plaatsvergelijking hoofdletter-onafhankelijk
  const juistePlaats =
    !harde.plaatsen ||
    harde.plaatsen.map(normalize).includes(normalize(woning.plaats));

  // Prijsvergelijking zoals je al had
  const juistePrijs =
    (!harde.prijsMin || woning.vraagprijs >= harde.prijsMin) &&
    (!harde.prijsMax || woning.vraagprijs <= harde.prijsMax);

  // Type ook hoofdletter-onafhankelijk, voor de zekerheid
  const juistType =
    !harde.type ||
    harde.type.map(normalize).includes(normalize(woning.objectsoort));

  return juistePlaats && juistePrijs && juistType;
}

function scoreZachteWensen(woning, zachte) {
  let score = 100;
  if (woning.kamers < (zachte.minKamers || 0)) score -= 20;
  if (woning.woonoppervlakte < (zachte.minM2 || 0)) score -= 20;

  const labels = ['A++', 'A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const indexWoning = labels.indexOf(woning.energielabel || 'G');
  const indexMin = labels.indexOf(zachte.energielabelMin || 'G');
  if (indexWoning > indexMin) score -= 10;

  if (zachte.buitenruimte && woning.buitenruimte) score += 5;

  return Math.max(Math.min(score, 100), 0);
}

function vindMatchesVoorWoning(woning) {
  const matches = [];
  for (const zp of zoekprofielen) {
    if (!zp.whatsappOptIn) continue;
    if (!voldoetAanHardeWensen(woning, zp.harde)) continue;

    const score = scoreZachteWensen(woning, zp.zachte);
    if (score >= MATCH_THRESHOLD) {
      matches.push({ zoekprofiel: zp, score });
    }
  }
  return matches;
}
// ----------------------------------------------------
// 5️⃣ WhatsApp bericht sturen
// ----------------------------------------------------
// ---------------------------------------------------------------------------
//  WhatsApp bericht sturen (met of zonder brochure)
// ---------------------------------------------------------------------------
async function sendWhatsAppAanbod(zoekprofiel, woning) {
  // 06… -> 316….
  const to = '31' + zoekprofiel.telefoon.replace(/^0/, '');

  const url = `https://graph.facebook.com/${WA_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

  // Fallback afbeelding voor je oude template (optioneel)
  const fallbackImageUrl = 'https://via.placeholder.com/600x400?text=Nieuw+aanbod';
  const imageUrl = woning.imageUrl || fallbackImageUrl;

  // Check of er een brochure aanwezig is
  const hasBrochure = !!woning.brochureUrl;

  // Template kiezen
const templateName = 'purchase_receipt_1';

  console.log(`📨 Template gekozen: ${templateName}`);

  // -----------------------------------------------------
  // Bouw de components op basis van wel/geen brochure
  // -----------------------------------------------------
  const components = [];

  // 1️⃣ HEADER alleen als brochure bestaat
  if (hasBrochure) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'document',
          document: {
            link: woning.brochureUrl,
            filename: `Brochure - ${woning.straat} ${woning.huisnummer}.pdf`
          }
        }
      ]
    });
  }

  // 2️⃣ BODY (zelfde in beide templates)
  components.push({
    type: 'body',
    parameters: [
      { type: 'text', text: woning.plaats || '' },                         // {{1}}
      { type: 'text', text: `${woning.straat || ''} ${woning.huisnummer || ''}`.trim() },  // {{2}}
      { type: 'text', text: `${woning.kamers ?? ''}` },                    // {{3}}
      { type: 'text', text: woning.appartementsoort || woning.objectsoort || '' },                    // {{4}}
      { type: 'text', text: `${woning.woonoppervlakte ?? ''}` },           // {{5}}
      { type: 'text', text: woning.buitenruimte || '' },                   // {{6}}
      { type: 'text', text: woning.energielabel || '' },                   // {{7}}
    ]
  });

  // -----------------------------------------------------
  // Complet e payload
  // -----------------------------------------------------
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'nl' },
      components
    }
  };

  console.log('📤 Uitgaande WhatsApp payload:', JSON.stringify(payload, null, 2));

  // -----------------------------------------------------
  // Versturen
  // -----------------------------------------------------
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    if (!res.ok) {
      console.error(`❌ WhatsApp API fout bij ${templateName}:`, text);
    } else {
      console.log(`✅ WhatsApp (${templateName}) verzonden naar ${zoekprofiel.telefoon}`);
      console.log('📨 API-response:', text);
    }
  } catch (err) {
    console.error('❌ Onverwachte fout bij WhatsApp-verzoek:', err);
  }
}

// ----------------------------------------------------
// 6️⃣ Start server
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server draait op poort ${PORT}`);
});

app.post('/', (req, res) => {
  console.log('📩 WhatsApp webhook ontvangen');
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

