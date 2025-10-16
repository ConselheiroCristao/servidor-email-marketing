// --- PASSO 1: Importar as ferramentas necessárias ---
import express from "express";
import cors from "cors";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import 'dotenv/config';
import fs from 'fs'; // Módulo para ler e escrever arquivos
import csv from 'csv-parser';

// --- PASSO 2: Configurar as ferramentas ---
const app = express();
app.use(cors());
app.use(express.json());
const sesClient = new SESClient({ region: process.env.AWS_REGION });
const contactsFilePath = 'contacts.csv';

// --- PASSO 3: Função de envio de e-mail ---
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

// --- PASSO 4: Endpoint de envio de campanha (Código Completo) ---
app.post("/enviar-campanha", (req, res) => {
  console.log("Recebido pedido para enviar campanha! Lendo lista de contatos...");
  const { subject, body } = req.body;
  const fromEmail = "contato@conselheirocristao.com.br";
  const contacts = [];

  if (!subject || !body) {
    return res.status(400).send("Erro: Assunto (subject) e corpo (body) são obrigatórios.");
  }

  fs.createReadStream(contactsFilePath)
    .pipe(csv())
    .on('data', (data) => {
      if (data.email) {
        contacts.push(data);
      }
    })
    .on('end', async () => {
      console.log(`${contacts.length} contatos carregados. Iniciando envios...`);
      if (contacts.length === 0) {
        return res.status(400).send("Nenhum contato válido no arquivo.");
      }
      try {
        for (const contact of contacts) {
          const personalizedBody = body.replace(/\[Nome do Assinante\]/g, contact.name || 'Amigo(a)');
          const sendEmailCommand = createSendEmailCommand(contact.email, fromEmail, subject, personalizedBody);
          await sesClient.send(sendEmailCommand);
          console.log(`E-mail enviado para: ${contact.email}`);
        }
        res.status(200).send(`Campanha enviada para ${contacts.length} contato(s)!`);
      } catch (error) {
        console.error("Falha ao enviar campanha:", error);
        res.status(500).send("Erro ao enviar a campanha.");
      }
    });
});

// --- PASSO 5: Endpoint para inscrever um novo contato ---
app.post("/inscrever", (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).send("Erro: Nome e e-mail são obrigatórios.");
  }
  
  const csvLine = `\n${name},${email}`;

  fs.appendFile(contactsFilePath, csvLine, (err) => {
    if (err) {
      console.error("Erro ao salvar o novo contato:", err);
      return res.status(500).send("Erro ao salvar o contato.");
    }
    console.log(`Novo contato salvo: ${name} <${email}>`);
    res.status(200).send("Inscrição realizada com sucesso!");
  });
});


// --- PASSO 6: Iniciar o servidor ---
// A linha abaixo usa a porta fornecida pelo Render (process.env.PORT)
// ou a porta 3000 se não houver nenhuma (no nosso computador local).
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log("Endpoints disponíveis:");
  console.log("POST /enviar-campanha");
  console.log("POST /inscrever");
});