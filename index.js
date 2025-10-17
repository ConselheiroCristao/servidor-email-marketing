// --- PASSO 1: Importar as ferramentas ---
import express from "express";
import cors from "cors";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';

// --- Função de inicialização do Firebase (sem alterações) ---
function initializeFirebase() {
  if (process.env.FIREBASE_CREDENTIALS) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("Firebase iniciado com credenciais de ambiente.");
  } else {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync('./firebase-credentials.json'));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log("Firebase iniciado com arquivo de credenciais local.");
    } catch (error) {
      console.error("Erro ao ler o arquivo de credenciais local.", error);
    }
  }
}
initializeFirebase();

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// Middleware para o AWS SNS (que envia 'text/plain' mas o conteúdo é JSON)
app.use(express.text({ type: ['text/plain', 'application/json'] }));

const sesClient = new SESClient({ region: process.env.AWS_REGION });

// --- Função de envio de e-mail (sem alterações) ---
const createSendEmailCommand = (toAddress, fromAddress, subject, body) => {
  return new SendEmailCommand({
    Destination: { ToAddresses: [toAddress] },
    Message: { Body: { Html: { Charset: "UTF-8", Data: body } }, Subject: { Charset: "UTF-8", Data: subject } },
    Source: fromAddress,
  });
};

// --- ATUALIZADO! (Passo 7) Endpoint de inscrição ---
app.post("/inscrever", async (req, res) => {
  
  // 1. AGORA TAMBÉM RECEBEMOS O 'source'
  const { name, email, source } = req.body;
  
  if (!name || !email) { 
    return res.status(400).send("Erro: Nome e e-mail são obrigatórios."); 
  }

  try {
    // 2. PREPARAMOS O NOVO OBJETO PARA O FIREBASE
    const novoContato = {
      name: name,
      email: email,
      createdAt: new Date(),
      source: source || 'desconhecida' // Se 'source' não for enviado, salva como 'desconhecida'
    };

    // 3. SALVAMOS O OBJETO COMPLETO
    const docRef = await db.collection('contatos').add(novoContato);
    
    console.log(`Novo contato salvo com o ID: ${docRef.id} (Origem: ${novoContato.source})`);
    res.status(200).send("Inscrição realizada com sucesso!");

  } catch (error) {
    console.error("Erro ao salvar o novo contato:", error);
    return res.status(500).send("Erro ao salvar o contato.");
  }
});

// --- Endpoint de envio de campanha (sem alterações) ---
app.post("/enviar-campanha", async (req, res) => {
  console.log("Recebido pedido para enviar campanha! Lendo contatos do Firebase...");
  const { subject, body } = req.body;
  const fromEmail = "contato@conselheirocristao.com.br";
  if (!subject || !body) { return res.status(400).send("Erro: Assunto (subject) e corpo (body) são obrigatórios."); }

  try {
    const snapshot = await db.collection('contatos').get();
    if (snapshot.empty) { return res.status(400).send("Nenhum contato encontrado."); }

    let count = 0;
    for (const doc of snapshot.docs) {
      const contact = doc.data();
      const contactId = doc.id; 

      const unsubscribeUrl = `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/cancelar-inscricao?id=${contactId}`;
      
      const footer = `
        <br><br>
        <p style="font-size: 12px; color: #888888; text-align: center;">
          Para não receber mais nossos e-mails, <a href="${unsubscribeUrl}">clique aqui</a>.
        </p>
      `;

      const personalizedBody = (body.replace(/\[Nome do Assinante\]/g, contact.name || 'Amigo(a)')) + footer;
      const sendEmailCommand = createSendEmailCommand(contact.email, fromEmail, subject, personalizedBody);
      
      await sesClient.send(sendEmailCommand);
      console.log(`E-mail enviado para: ${contact.email}`);
      count++;
    }
    res.status(200).send(`Campanha enviada com sucesso para ${count} contato(s)!`);
  } catch (error) {
    console.error("Falha ao enviar campanha:", error);
    res.status(500).send("Erro ao enviar a campanha.");
  }
});

// --- Endpoint para cancelar a inscrição (sem alterações) ---
app.get("/cancelar-inscricao", async (req, res) => {
  const contactId = req.query.id;
  if (!contactId) {
    return res.status(400).send("ID do contato não fornecido. Não foi possível cancelar a inscrição.");
  }
  try {
    await db.collection('contatos').doc(contactId).delete();
    console.log(`Contato com ID ${contactId} foi removido.`);
    res.send(`
      <div style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h1>Inscrição Cancelada</h1>
        <p>Você não receberá mais nossos e-mails. Sentiremos sua falta!</p>
      </div>
    `);
  } catch (error) {
    console.error("Erro ao cancelar inscrição:", error);
    res.status(500).send("Ocorreu um erro ao processar seu pedido. Por favor, tente novamente.");
  }
});


// --- Endpoint Ouvinte do AWS SNS (sem alterações) ---
app.post("/aws-sns-listener", async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body);
    const messageType = req.headers['x-amz-sns-message-type'];

    if (messageType === 'SubscriptionConfirmation') {
      console.log("AWS enviou uma confirmação de inscrição.");
      console.log("VISITE ESTE LINK PARA CONFIRMAR (SE AINDA NÃO FEZ):");
      console.log(payload.SubscribeURL);
      res.status(200).send("OK (SubscriptionConfirmation recebida)");

    } else if (messageType === 'Notification') {
      console.log("Notificação (Bounce/Complaint) recebida!");
      
      const notificationBody = JSON.parse(payload.Message);
      const notificationType = notificationBody.notificationType;

      let recipients = [];

      if (notificationType === 'Bounce') {
        const bounce = notificationBody.bounce;
        if (bounce.bounceType === 'Permanent') {
          console.log(`Bounce PERMANENTE detectado. Tipo: ${bounce.bounceSubType}`);
          recipients = bounce.bouncedRecipients.map(r => r.emailAddress);
        } else {
          console.log(`Bounce temporário (Transient) ignorado. Tipo: ${bounce.bounceSubType}`);
        }
      } else if (notificationType === 'Complaint') {
        console.log("Reclamação (Complaint) detectada.");
        recipients = notificationBody.complaint.complainedRecipients.map(r => r.emailAddress);
      }

      if (recipients.length > 0) {
        console.log("Iniciando limpeza dos seguintes e-mails:", recipients);
        
        for (const email of recipients) {
          const query = db.collection('contatos').where('email', '==', email);
          const snapshot = await query.get();

          if (snapshot.empty) {
            console.log(`E-mail ${email} não encontrado no Firebase (talvez já limpo).`);
          } else {
            snapshot.forEach(async (doc) => {
              await db.collection('contatos').doc(doc.id).delete();
              console.log(`SUCESSO: E-mail ${email} (ID: ${doc.id}) foi removido do Firebase.`);
            });
          }
        }
      }
      
      res.status(200).send("OK (Notificação processada)");

    } else {
      console.warn("Recebida mensagem SNS de tipo desconhecido:", messageType);
      res.status(400).send("Tipo de mensagem não suportado.");
    }

  } catch (error) {
    console.error("Erro ao processar mensagem do SNS:", error);
    console.error("Body recebido (pode não ser JSON válido):", req.body);
    res.status(500).send("Erro interno no processamento do SNS.");
  }
});


// --- PASSO FINAL: Iniciar o servidor ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log("Conectado ao Firebase e pronto para receber pedidos.");
});