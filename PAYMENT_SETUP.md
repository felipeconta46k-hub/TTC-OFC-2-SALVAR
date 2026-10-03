# Pix direto e painel do vendedor

O cliente paga por Pix diretamente na chave da loja. O valor é incluído no QR Code de cada pedido. Você confere o recebimento no aplicativo do banco e depois entra no painel do vendedor para marcar o pedido como pago. **Este fluxo não confirma pagamentos automaticamente.** O recebimento é feito diretamente pelo seu banco, sem checkout do Mercado Pago; consulte as tarifas e regras da sua instituição.

## 1. Instalar Node.js e preparar o projeto

1. Instale Node.js 20 ou superior em https://nodejs.org/.
2. Abra um PowerShell na pasta do projeto e confirme `node --version` e `npm --version`.
3. Instale as dependências com `npm install`.
4. Nunca publique ou compartilhe o arquivo `.env`. O arquivo `.gitignore` já o exclui do Git.

## 2. Criar o PostgreSQL no Supabase

1. Crie um projeto em https://supabase.com/ e guarde a senha do banco.
2. No painel do projeto, copie uma connection string PostgreSQL. Para serviços que não suportem IPv6, tente a URL de conexão do Session pooler.
3. A connection string contém a senha do banco: mantenha-a privada.

## 3. Criar a chave Pix

Use a chave Pix que pertence à sua conta bancária/conta de recebimento. Pode ser chave aleatória, e-mail, telefone ou CPF/CNPJ que seu banco aceite para Pix.

O QR gerado é uma cobrança Pix estática com valor e identificador de pedido preenchidos. Antes de usar com clientes, teste uma leitura com o aplicativo de banco pagador e confira se o nome do beneficiário e o valor exibidos estão corretos. A leitura do QR, por si só, não confirma o pagamento.

## 4. Configurar e publicar no Render

1. Envie o código atualizado ao GitHub **sem `.env`**.
2. No Render, crie um Blueprint apontando para o repositório. O arquivo `render.yaml` cria o serviço web e solicita as variáveis secretas.
3. Configure estas variáveis:

| Variável | O que informar |
|---|---|
| `APP_BASE_URL` | URL HTTPS pública do seu serviço Render, como `https://sua-loja.onrender.com` |
| `DATABASE_URL` | Connection string PostgreSQL do Supabase |
| `PIX_KEY` | Sua chave Pix de recebimento |
| `PIX_RECEIVER_NAME` | Nome do titular como aparece no banco, até 25 caracteres |
| `PIX_RECEIVER_CITY` | Cidade do titular, sem acentos, até 15 caracteres |
| `SELLER_PASSWORD` | Senha forte e exclusiva para o painel do vendedor, com ao menos 16 caracteres |
| `SESSION_SECRET` | Segredo aleatório com pelo menos 32 caracteres para assinar a sessão do vendedor |

Não coloque valores reais dessas variáveis no chat ou em arquivos versionados. No PowerShell, você pode gerar um segredo aleatório sem instalar programas:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Gere um segredo para `SESSION_SECRET` e uma senha exclusiva e guarde ambos em um gerenciador de senhas. **Não use o mesmo valor para ambos.** Configure a senha no painel do Render sem enviá-la ao assistente.

4. Aguarde o deploy. Abra `https://SUA-URL/api/health`; deve retornar `{"status":"ok"}`. Na primeira inicialização o servidor cria a tabela de pedidos.

## 5. Testar antes de divulgar

1. Abra a URL HTTPS da loja e faça um pedido de teste usando um valor pequeno.
2. Leia o QR gerado com outro aplicativo de banco. Confira cuidadosamente nome do recebedor, chave e valor antes de pagar.
3. Faça o pagamento de teste e confirme no aplicativo **da conta que recebe** que o Pix entrou. Um comprovante mostrado pelo comprador ou uma página aberta no navegador não é confirmação suficiente.
4. Abra `https://SUA-URL/vendedor`, informe `SELLER_PASSWORD` e encontre o pedido pelo ID.
5. Confira o valor, o nome, o endereço e o pedido antes de selecionar **Marcar como pago**. Só faça isso após verificar o crédito no extrato do banco.
6. Confirme que o site mostra o pedido como pago. Teste também que pedido não pago continua pendente.

## 6. Como operar pedidos

1. No painel `/vendedor`, localize os novos pedidos pendentes.
2. Use o ID do pedido para organizar a separação e o envio.
3. Para validar o Pix, confira no extrato do banco o recebimento e o valor; quando possível, compare também o identificador da transação.
4. Marque como pago no painel **somente após o valor estar creditado**.
5. Despache o produto e use seu processo de logística para comunicar o envio ao cliente.

O painel é protegido por senha, tem limite de tentativas de login e usa cookie seguro em HTTPS. Guarde a senha. Se `SESSION_SECRET` for trocado, as sessões abertas deixam de funcionar.

## Limitações e observações importantes

- F12 e as ferramentas de desenvolvedor não podem ser bloqueados de forma confiável; o código e a interface enviados ao navegador são visíveis ao usuário. A proteção real é manter segredos no servidor, validar operações na API e atualizar as dependências.
- O servidor envia cabeçalhos de segurança, limita tentativas de autenticação e pedidos e exige uma sessão de cliente para consultar o status de um pedido. Isso reduz riscos comuns, mas não substitui revisão contínua, backups e atualização de credenciais expostas.
- Com QR Pix e confirmação manual, não há webhook bancário nem confirmação automática. O cliente pode iniciar um pedido sem pagar; ele continua pendente até ser conferido por você.
- O servidor calcula o total com base nos preços do catálogo em `catalog.js`; mantenha os preços de `catalog.js` e `app.js` sincronizados.
- O QR Pix fica pendente até a confirmação manual e não expira automaticamente. Se houver pagamento duplicado ou a maior, confira o extrato e resolva a diferença diretamente com o cliente.
- As contas de cliente novas são armazenadas no PostgreSQL; a senha é protegida com hash scrypt e nunca fica salva em texto puro. Cada cliente precisa criar sua conta novamente: os cadastros antigos que estavam apenas no navegador não são migrados. O painel do vendedor usa autenticação separada.
- Render gratuito pode suspender o servidor por inatividade. Isso pode atrasar o carregamento da loja e do painel; confira as condições do plano antes de depender dele para vendas.
