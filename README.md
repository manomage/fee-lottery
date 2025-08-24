# fee-lottery

#ENV CONFIG; 
```
BAGS_API_KEY=
SOLANA_RPC_URL=https:
PRIVATE_KEY=your_base58_encoded_private_key_here
MORALIS_API_KEY=
LOTTERY_POT_THRESHOLD=1
PAYOUT_PERCENTAGE=0.25
SLIPPAGE_BPS=150
TIME_LIMIT_MINUTES=10
BAGS_API_URL=https://public-api-v2.bags.fm/api/v1/  # Assumed base URL
JUPITER_API_URL=
PROJECT_TOKEN_MINT_ADDRESS=
sbQueue=
PRIVATE_KEY=wallet.json
MONGO_URI=
sbProgramId=
```

#RUN
```
cd sb-randomness 
Anchor build

cd fee-lottery
npm i
npm run server
```
