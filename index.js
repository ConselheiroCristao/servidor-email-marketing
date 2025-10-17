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

// --- NOVO! (Passo 3) ---
// Middleware para o AWS SNS (que envia 'text/plain' mas o conteúdo é JSON)
app.use(express.text({ type: ['text/plain', 'application/json'] }));
// --- FIM DA ADIÇÃO ---

const sesClient = new SESClient({ region: process.env.AWS_REGION });

// --- Função de envio de e-mail (sem alterações) ---
const createSendEmailCommand = (toAddress, fromAddress, subject, body) => {
  return new SendEmailCommand({
    Destination: { ToAddresses: [toAddress] },
    Message: { Body: { Html: { Charset: "UTF-8", Data: body } }, Subject: { Charset: "UTF-8", Data: subject } },
    Source: fromAddress,
  });
};

// --- Endpoint de inscrição (sem alterações) ---
app.post("/inscrever", async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) { return res.status(400).send("Erro: Nome e e-mail são obrigatórios."); }
  try {
    const docRef = await db.collection('contatos').add({ name: name, email: email, createdAt: new Date() });
    console.log(`Novo contato salvo com o ID: ${docRef.id}`);
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
      const contactId = doc.id; // Pegamos o ID único do documento no Firebase

      // Criamos o URL único de cancelamento para este contato
      const unsubscribeUrl = `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}/cancelar-inscricao?id=${contactId}`;

      // Criamos um rodapé padrão para todos os e-mails
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
  // Pegamos o ID do contato que veio no link (ex: ?id=j3KobCCw...)
  const contactId = req.query.id;

  if (!contactId) {
    return res.status(400).send("ID do contato não fornecido. Não foi possível cancelar a inscrição.");
  }

  try {
    // Dizemos ao Firebase para deletar o documento com este ID na coleção 'contatos'
    await db.collection('contatos').doc(contactId).delete();
    console.log(`Contato com ID ${contactId} foi removido.`);
    // Enviamos uma mensagem de sucesso para o navegador do usuário
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


// --- NOVO! (Passo 4) Endpoint Ouvinte do AWS SNS ---
// Este é o "portal" que vai receber as notificações da AWS
app.post("/aws-sns-listener", async (req, res) => {
  let payload;
  try {
    // O body vem como 'text/plain', então primeiro o transformamos em objeto
    payload = JSON.parse(req.body);
    console.log("Mensagem recebida da AWS SNS!");

    // 1. Verificação do Tipo de Mensagem
    // A AWS nos diz que tipo de mensagem está enviando
    const messageType = req.headers['x-amz-sns-message-type'];

    if (messageType === 'SubscriptionConfirmation') {
      // --- ESTE É O "APERTO DE MÃO" ---
      // A AWS está testando se este endpoint é real
      console.log("AWS enviou uma confirmação de inscrição.");
      console.log("------------------------------------------------------");
      console.log("VISITE ESTE LINK PARA CONFIRMAR (COPIE E COLE NO SEU NAVEGADOR):");
      // Nós pegamos o link que ela enviou e mostramos no log
      console.log(payload.SubscribeURL);
      console.log("------------------------------------------------------");
      
      // Apenas respondemos 'OK' para a AWS saber que recebemos
      res.status(200).send("OK (SubscriptionConfirmation recebida, cheque os logs para confirmar)");

    } else if (messageType === 'Notification') {
      // --- AQUI É O AVISO DE BOUNCE (QUE FAREMOS NO PRÓXIMO PASSO) ---
      console.log("Recebida uma Notificação (provavelmente um bounce ou complaint).");
      
      // No próximo passo, vamos adicionar o código para
      // 1. Ler o 'payload.Message'
      // 2. Descobrir qual e-mail falhou
      // 3. Deletar esse e-mail do Firebase
      
      res.status(200).send("OK (Notificação recebida)");

    } else {
      // Outro tipo de mensagem que não esperamos
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