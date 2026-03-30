# VoidTrader

Aplicação executável (Node.js + Express) para otimizar compras no Warframe Market.

## Requisitos
- Node.js 18+
- npm

## Como executar
```bash
npm install
npm start
```

Acesse: `http://localhost:3000`

## Desenvolvimento
```bash
npm run dev
```

## Endpoint backend
- `POST /api/best-seller`
- `GET /health`

Exemplo de payload:
```json
{
  "items": ["Volt Prime Chassis", "Nova Prime Systems"]
}
```

## Observação
Esta versão é focada em execução local/servidor e **não usa GitHub Pages**.
