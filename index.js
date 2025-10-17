// --- PASSO 1: Importar as ferramentas ---
import express from "express";
import cors from "cors";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';

// --- ATUALIZAÇÃO IMPORTANTE! ---
// Esta função irá carregar nossas credenciais do Firebase de forma inteligente.
function initializeFirebase() {
  // Se a variável de ambiente FIREBASE_CREDENTIALS existir (no Render)...
  if (process.env.FIREBASE_CREDENTIALS) {
    // ...usamos o conteúdo dela.
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase iniciado com credenciais de ambiente.");
  } else {
    // Senão (no nosso computador local)...
    // ... lemos o arquivo local.
    try {
      const serviceAccount = JSON.parse(fs.readFileSync('./firebase-credentials.json'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("Firebase iniciado com arquivo de credenciais local.");
    } catch (error) {
      console.error("Erro ao ler o arquivo de credenciais local. Certifique-se de que 'firebase-credentials.json' existe ou configure a variável de ambiente FIREBASE_CREDENTIALS.", error);
    }
  }
}

initializeFirebase(); // Executamos a função para iniciar a conexão.

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());
const sesClient = new SESClient({ region: process.env.AWS_REGION });

// --- O RESTO DO CÓDIGO (ENDPOINTS E SERVIDOR) CONTINUA EXATAMENTE O MESMO ---

const createSendEmailCommand = (toAddress, fromAddress, subject, body) => {
  return new SendEmailCommand({
    Destination: { ToAddresses: [toAddress] },
    Message: {
      Body: { Html: { Charset: "UTF-8", Data: body } },
      Subject: { Charset: "UTF-8", Data: subject },
    },
    Source: fromAddress,
  });
};

app.post("/inscrever", async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).send("Erro: Nome e e-mail são obrigatórios.");
  }
  try {
    const docRef = await db.collection('contatos').add({
      name: name,
      email: email,
      createdAt: new Date()
    });
    console.log(`Novo contato salvo com o ID: ${docRef.id}`);
    res.status(200).send("Inscrição realizada com sucesso!");
  } catch (error) {
    console.error("Erro ao salvar o novo contato:", error);
    return res.status(500).send("Erro ao salvar o contato.");
  }
});

app.post("/enviar-campanha", async (req, res) => {
  console.log("Recebido pedido para enviar campanha! Lendo contatos do Firebase...");
  const { subject, body } = req.body;
  const fromEmail = "contato@conselheirocristao.com.br";
  if (!subject || !body) {
    return res.status(400).send("Erro: Assunto (subject) e corpo (body) são obrigatórios.");
  }
  try {
    const snapshot = await db.collection('contatos').get();
    if (snapshot.empty) {
      return res.status(400).send("Nenhum contato encontrado.");
    }
    let count = 0;
    for (const doc of snapshot.docs) {
      const contact = doc.data();
      const personalizedBody = body.replace(/\[Nome do Assinante\]/g, contact.name || 'Amigo(a)');
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log("Conectado ao Firebase e pronto para receber pedidos.");
});