// test-send.js
require('dotenv').config();
// Node 18+ heeft fetch al ingebouwd, dus we hoeven niks te importeren.

// CHECK: gebruiken we de juiste env-variabelen?
const WA_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';


const WA_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

if (!WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
  console.error('❌ WHATSAPP_PHONE_NUMBER_ID of WHATSAPP_ACCESS_TOKEN mist. Vul ze in je .env of Render Environment in.');
  process.exit(1);
}

// 👇 TELEFOONNUMMER: vul hier je eigen 06 in
// Voorbeeld: '0612345678' wordt omgezet naar '31612345678'
const TEST_TELEFOON = '0613185813';

function normalizePhoneNumber(nlPhone) {
  if (!nlPhone) return null;
  let digits = nlPhone.replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (!digits.startsWith('31')) {
    digits = '31' + digits;
  }
  return digits;
}

async function main() {
  const to = normalizePhoneNumber(TEST_TELEFOON);
  if (!to) {
    console.error('❌ Geen geldig nummer ingevuld in TEST_TELEFOON');
    process.exit(1);
  }

  // EERSTE TEST: heel simpel tekstbericht (geen template)
  const url = `https://graph.facebook.com/${WA_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: {
      body: 'Testbericht vanaf Node.js 🚀 (als je dit leest, werkt je access token!)'
    }
  };

  console.log('➡️ Versturen naar:', url);
  console.log('➡️ Naar nummer:', to);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log('⬅️ Antwoord van WhatsApp API:');
  console.log(JSON.stringify(data, null, 2));

  if (res.ok) {
    console.log('✅ Bericht succesvol verstuurd!');
  } else {
    console.log('❌ Er ging iets mis (zie antwoord hierboven).');
  }
}

main().catch(err => {
  console.error('❌ Onverwachte fout:', err);
});

