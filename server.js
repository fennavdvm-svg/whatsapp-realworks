
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

  const objectUrl = req.body.objectUrl;
  if (!objectUrl) {
    console.log('❌ Geen objectUrl in webhook');
    return res.sendStatus(200);
  }

  try {
    const woningRaw = await fetch(objectUrl, {
      headers: {
        Authorization: RW_TOKEN,
        Accept: 'application/json',
      },
    }).then(r => r.json());

    const woning = mapRealworksObjectToInternalModel(woningRaw);
    console.log('📦 Gemapte woning:', woning);

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
// 3️⃣ Mapping Realworks -> intern woning model
// ----------------------------------------------------
function mapRealworksObjectToInternalModel(rw) {
  const adres = rw.adres || {};
  const huisnr = adres.huisnummer || {};
  const algemeen = rw.algemeen || {};
  const prijs = rw.prijs || rw.financieel || {};
  const opp = rw.oppervlakte || rw.maten || {};
  const energie = rw.energie || rw.energielabel || {};
  const links = rw.links || {};

  const huisnummer = `${huisnr.hoofdnummer || ''}${huisnr.toevoeging ? ' ' + huisnr.toevoeging : ''}`.trim();

  return {
    id: rw.objectcode || rw.id || null,
    straat: adres.straat || null,
    huisnummer,
    plaats: adres.plaats || null,
    postcode: adres.postcode || null,
    vraagprijs: Number(prijs.vraagprijs || 0),
    kamers: Number(algemeen.aantalKamers || 0),
    woonoppervlakte: Number(opp.woonoppervlakte || 0),
    energielabel: energie.energielabel || null,
    buitenruimte: rw.tuin ? 'TUIN' : 'BALKON',
    objectsoort: algemeen.soort || 'woning',
    fundaUrl: links.funda || null,
  };
}

// ----------------------------------------------------
// 4️⃣ Simpele zoekprofielen (tijdelijk hardcoded)
// ----------------------------------------------------
const zoekprofielen = [
  {
    id: 1,
    zoekerNaam: 'Fenna Test',
    telefoon: '0612345678',
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
function voldoetAanHardeWensen(woning, harde) {
  const juistePlaats = !harde.plaatsen || harde.plaatsen.includes(woning.plaats);
  const juistePrijs =
    (!harde.prijsMin || woning.vraagprijs >= harde.prijsMin) &&
    (!harde.prijsMax || woning.vraagprijs <= harde.prijsMax);
  const juistType =
    !harde.type || harde.type.includes(woning.objectsoort);

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
async function sendWhatsAppAanbod(zoekprofiel, woning) {
  const to = '31' + zoekprofiel.telefoon.replace(/^0/, '');
  const url = `https://graph.facebook.com/${WA_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: 'aanbod_brochure',
      language: { code: 'nl' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: woning.plaats || '' },
            { type: 'text', text: `${woning.straat} ${woning.huisnummer}` },
            { type: 'text', text: woning.kamers.toString() },
            { type: 'text', text: woning.objectsoort },
            { type: 'text', text: woning.woonoppervlakte.toString() },
            { type: 'text', text: woning.buitenruimte || '' },
            { type: 'text', text: woning.energielabel || '' },
          ],
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error('❌ WhatsApp API fout', await res.text());
  } else {
    console.log(`✅ WhatsApp verzonden naar ${zoekprofiel.telefoon}`);
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

