import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, burn, getAssociatedTokenAddress } from "@solana/spl-token";
import { ON_DEMAND_DEVNET_PID } from '@switchboard-xyz/on-demand';
import axios from "axios";
import { MongoClient } from 'mongodb'; // For off-chain storage
import { BagsSDK } from "@bagsfm/bags-sdk";
import BN from 'bn.js';
import { requestVRF, consumeRandomness } from './VRF';
import { getTradersWallet } from './getTradersWallet';
import * as dotenv from 'dotenv';
import fs from 'fs';

// Load environment variables
dotenv.config();

// --- Configuration (from environment variables) ---
// Make sure these environment variables are set when running the worker
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "http://localhost:8899"; // Default to local validator
const PRIVATE_KEY = process.env.PRIVATE_KEY; // The private key of the worker's wallet (e.g., [1,2,3,...])
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017"; // MongoDB connection URI
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "fee_lottery"; // MongoDB database name
const JUPITER_API_URL = process.env.JUPITER_API_URL || "https://lite-api.jup.ag"; // Jupiter Aggregator API URL
const PROJECT_TOKEN_MINT_ADDRESS = process.env.PROJECT_TOKEN_MINT_ADDRESS; // Mint address of the SPL token to buy and burn
const sbQueue = process.env.sbQueue; // Switchboard VRF Oracle Queue Public Key
const sbProgramId = ON_DEMAND_DEVNET_PID;
const LOTTERY_POT_THRESHOLD_SOL = parseFloat(process.env.LOTTERY_POT_THRESHOLD_SOL || "1.0"); // Threshold in SOL
const LOTTERY_POT_THRESHOLD = LOTTERY_POT_THRESHOLD_SOL * LAMPORTS_PER_SOL; // Convert to lamports
const BAGS_API_KEY: string =
    process.env.BAGS_API_KEY ?? (() => { throw new Error("BAGS_API_KEY is required"); })();

if (!PRIVATE_KEY || !PROJECT_TOKEN_MINT_ADDRESS || !sbQueue || !sbProgramId) {
    console.error("Missing environment variables. Please set PRIVATE_KEY, PROJECT_TOKEN_MINT_ADDRESS, sbQueue, and sbProgramId.");
    process.exit(1);
}

// --- Solana Setup ---
const connection = new Connection(SOLANA_RPC_URL, "confirmed");

// Load keypair from PRIVATE_KEY or file
let privateKey: number[];
if (PRIVATE_KEY && (PRIVATE_KEY.startsWith('./') || PRIVATE_KEY.endsWith('.json'))) {
  // If PRIVATE_KEY is a file path, read the file
  const fileContent = fs.readFileSync(PRIVATE_KEY, 'utf8');
  privateKey = JSON.parse(fileContent);
} else {
  // Otherwise, parse PRIVATE_KEY directly
  privateKey = JSON.parse(PRIVATE_KEY || '[]');
}

const workerKeypair = Keypair.fromSecretKey(Uint8Array.from(privateKey));

// --- MongoDB Setup ---
let db: any; // MongoDB database instance
let mongoClient: MongoClient;

async function connectToMongoDB() {
    try {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db(MONGO_DB_NAME);
        console.log("Connected to MongoDB");
    } catch (error) {
        console.error("Failed to connect to MongoDB:", error);
        process.exit(1); // Exit if cannot connect to DB
    }
}

// --- Lottery State Variables ---
let isLotteryRunning = false;
let currentPotSize = 0; // Accumulated fees in lamports

const sdk = new BagsSDK(BAGS_API_KEY, connection, "processed");

// --- Integrated claimFeesForToken function from claim-fees.ts ---
async function claimFeesForToken(tokenMint: string, keypair: Keypair): Promise<boolean> {
    try {
        console.log(`💰 Claiming fees for token ${tokenMint} with wallet ${keypair.publicKey.toBase58()}`);
        const connection = sdk.state.getConnection();
        const commitment = sdk.state.getCommitment();
        console.log("🔍 Fetching all claimable positions...");
        // Get all claimable positions for the wallet
        const allPositions = await sdk.fee.getAllClaimablePositions(keypair.publicKey);
        if (allPositions.length === 0) {
            console.log("❌ No claimable positions found for this wallet.");
            currentPotSize = 0; // Reset pot size if no claimable fees
            return false;
        }
        console.log(`📋 Found ${allPositions.length} total claimable position(s)`);
        // Filter positions for the specific token mint
        const targetPositions = allPositions.filter(position => position.baseMint === tokenMint);
        if (targetPositions.length === 0) {
            console.log(`❌ No claimable positions found for token mint: ${tokenMint}`);
            console.log("Available token mints:");
            allPositions.forEach((position, index) => {
                console.log(` ${index + 1}. ${position.baseMint}`);
            });
            currentPotSize = 0; // Reset pot size if no claimable fees for the target token
            return false;
        }
        console.log(`✅ Found ${targetPositions.length} claimable position(s) for target token`);
        // Calculate total claimable amount for the pot
        currentPotSize = 0;
        targetPositions.forEach((position, index) => {
            console.log(`\n📊 Position ${index + 1}:`);
            console.log(` 🪙 Token: ${position.baseMint}`);
            console.log(` 🏊 Virtual Pool: ${position.virtualPoolAddress}`);
            if (position.virtualPoolClaimableAmount) {
                const virtualAmount = Number(position.virtualPoolClaimableAmount);
                currentPotSize += virtualAmount;
                console.log(` 💰 Virtual Pool Claimable: ${(virtualAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
            }
            if (position.dammPoolClaimableAmount) {
                const dammAmount = Number(position.dammPoolClaimableAmount);
                currentPotSize += dammAmount;
                console.log(` 💰 DAMM Pool Claimable: ${(dammAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
            }
            if (position.isCustomFeeVault) {
                const customFeeVaultBalance = Number(position.customFeeVaultBalance);
                const bps = position.customFeeVaultBps;
                const claimableAmount = customFeeVaultBalance * (bps / 10000);
                currentPotSize += claimableAmount;
                console.log(` 🏦 Custom Fee Vault: Yes`);
                console.log(` 📍 Claimer Side: ${position.customFeeVaultClaimerSide}`);
                console.log(` 💰 Custom Fee Vault Claimable: ${claimableAmount.toFixed(6)} SOL`);
            }
        });
        console.log(`\n💰 Total claimable pot size: ${(currentPotSize / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

        // Only proceed with claiming if the pot size meets the threshold
        if (currentPotSize < LOTTERY_POT_THRESHOLD) {
            console.log(`Pot size ${(currentPotSize / LAMPORTS_PER_SOL).toFixed(6)} SOL is below threshold ${LOTTERY_POT_THRESHOLD_SOL} SOL. Skipping claim.`);
            return false;
        }

        console.log("\n🎯 Creating claim transactions...");
        // Process each target position
        for (let i = 0; i < targetPositions.length; i++) {
            const position = targetPositions[i];
            console.log(`\n⚙️ Processing position ${i + 1}/${targetPositions.length}...`);
            // Generate claim transactions for this position
            const claimTransactions = await sdk.fee.getClaimTransaction(
                keypair.publicKey,
                position
            );
            if (!claimTransactions || claimTransactions.length === 0) {
                console.log(`⚠️ No claim transactions generated for this position.`);
                continue;
            }
            console.log(`✨ Generated ${claimTransactions.length} claim transaction(s)`);
            // Sign and send transactions
            console.log(`🔑 Signing and sending transactions...`);
            for (let j = 0; j < claimTransactions.length; j++) {
                const transaction = claimTransactions[j];
                try {
                    transaction.sign([keypair]);
                    const blockhash = await connection.getLatestBlockhash(commitment);
                    const txSignature = await connection.sendTransaction(transaction, {
                        maxRetries: 0,
                        skipPreflight: true
                    });
                    console.log(`🔑 Confirming transaction signature: ${txSignature}`);
                    const confirmed = await connection.confirmTransaction({
                        blockhash: blockhash.blockhash,
                        lastValidBlockHeight: blockhash.lastValidBlockHeight,
                        signature: txSignature,
                    }, commitment);
                    if (confirmed.value.err) {
                        console.error(`💥 Error confirming transaction ${j + 1}:`, confirmed.value.err);
                        throw new Error("Error confirming transaction");
                    }
                    else {
                        console.log(`✅ Transaction ${j + 1} confirmed successfully!`);
                    }
                } catch (txError) {
                    console.error(`🚨 Failed to send transaction ${j + 1}:`, txError);
                }
            }
        }
        console.log("🎉 Fee claiming process completed!");
        return true; // Indicate successful claim
    }
    catch (error) {
        console.error("🚨 Unexpected error occurred:", error);
        return false; // Indicate failure
    }
}

async function processLottery(winnerWallet: PublicKey, potSize: number) {
  try {
    console.log(`Processing lottery for pot size: ${potSize / LAMPORTS_PER_SOL} SOL`);

    // --- 1. Payout to winner ---
    const payoutAmount = Math.floor(potSize * PAYOUT_PERCENTAGE);
    console.log(`Sending ${payoutAmount / LAMPORTS_PER_SOL} SOL to winner: ${winnerWallet.toString()}`);

    const payoutTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: workerKeypair.publicKey,
        toPubkey: winnerWallet,
        lamports: payoutAmount,
      })
    );
    const payoutSig = await sendAndConfirmTransaction(connection, payoutTx, [workerKeypair]);
    console.log(`Payout transaction confirmed: ${payoutSig}`);

    // --- 2. Buy & Burn ---
    const burnAmountInSOL = potSize - payoutAmount;
    console.log(`Using ${burnAmountInSOL / LAMPORTS_PER_SOL} SOL to buy and burn tokens.`);

    // Convert PROJECT_TOKEN_MINT_ADDRESS to PublicKey
    let projectTokenMint: PublicKey;
    try {
      projectTokenMint = new PublicKey(PROJECT_TOKEN_MINT_ADDRESS!); // Non-null assertion
    } catch (error) {
      throw new Error(`Invalid PROJECT_TOKEN_MINT_ADDRESS: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // a. Get swap quote and instructions from Jupiter
    const quoteResponse = await axios.get(`${JUPITER_API_URL}/swap/v1/quote`, {
      params: {
        inputMint: "So11111111111111111111111111111111111111112", // SOL mint address
        outputMint: projectTokenMint.toString(), // Use PublicKey string representation
        amount: burnAmountInSOL,
        slippageBps: 50, // 0.5% slippage
      },
    });
    console.log({ quoteResponse: quoteResponse.data });

    if (!quoteResponse.data.outAmount) {
      console.error("Jupiter quote failed to return an output amount.");
      throw new Error("Jupiter swap quote failed.");
    }

    const swapResponse = await axios.post(`${JUPITER_API_URL}/swap/v1/swap`, {
      quoteResponse: quoteResponse.data,
      userPublicKey: workerKeypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 10000,
      destinationTokenAccount: (
        await getAssociatedTokenAddress(
          projectTokenMint, // Use PublicKey
          workerKeypair.publicKey,
          true, // allowOwnerOffCurve
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      ).toString(),
    });

    // b. Execute the swap transaction
    const swapTransaction = Transaction.from(Buffer.from(swapResponse.data.swapTransaction, "base64"));
    const swapSig = await sendAndConfirmTransaction(connection, swapTransaction, [workerKeypair]);
    console.log(`Swap transaction confirmed: ${swapSig}`);

    // c. Burn the acquired SPL tokens
    const projectTokenAccount = await getAssociatedTokenAddress(
      projectTokenMint, // Use PublicKey
      workerKeypair.publicKey,
      true, // allowOwnerOffCurve
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Fetch the balance of the newly acquired tokens
    const tokenAccountInfo = await connection.getTokenAccountBalance(projectTokenAccount);
    const tokensToBurn = new BN(tokenAccountInfo.value.amount);
    const tokenDecimals = tokenAccountInfo.value.decimals;

    // Safety check: ensure there are tokens to burn
    if (tokensToBurn.toNumber() > 0) {
      console.log(
        `Burning ${tokensToBurn.toString()} tokens from pot (raw amount, ${
          tokensToBurn.toNumber() / Math.pow(10, tokenDecimals)
        } with decimals).`
      );

      const burnSig = await burn(
        connection,
        workerKeypair, // payer
        projectTokenAccount, // account
        projectTokenMint, // mint
        workerKeypair.publicKey, // owner
        tokensToBurn.toNumber() // amount
      );

      console.log(`Burn transaction confirmed: ${burnSig}`);
    } else {
      console.warn("No tokens acquired to burn. Check Jupiter swap success and token balance.");
    }

    // --- 3. Store Receipt Off-Chain (for quick API access) ---
    const receipt = {
      potSize,
      winner: winnerWallet.toString(),
      payoutTxSig: payoutSig,
      buyTxSig: swapSig,
      burnAmount: tokensToBurn.toString(),
      timestamp: new Date(),
    };

    await db.collection("lotteryReceipts").insertOne(receipt);
    console.log("Lottery receipt stored in MongoDB.");

  } catch (error) {
    console.error("An error occurred during lottery processing:", error);
    throw error;
  } finally {
    isLotteryRunning = false;
    currentPotSize = 0; // Reset pot after a round
  }
}

// --- Main Worker Loop ---
const CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
const PAYOUT_PERCENTAGE = 0.25; // 25% payout to winner

async function mainLoop() {
  console.log("Lottery worker started.");
  await connectToMongoDB();

  setInterval(async () => {
      if (isLotteryRunning) {
          console.log("Lottery is currently running, skipping this check.");
          return;
      }

      try {
          // Monitor and Claim Fees for the Market ---
          console.log(`Monitoring claimable fees for market: ${PROJECT_TOKEN_MINT_ADDRESS}`);
          
          // Use claimFeesForToken to monitor and potentially claim fees
          const feesClaimed = await claimFeesForToken(PROJECT_TOKEN_MINT_ADDRESS!, workerKeypair);
          
          // Update status in MongoDB
          await db.collection("lotteryStatus").updateOne(
              { _id: "current" }, // Fixed ID for the single status document
              {
                  $set: {
                      currentPotSize,
                      isLotteryRunning,
                      marketMint: PROJECT_TOKEN_MINT_ADDRESS,
                      lastUpdated: new Date(),
                  },
              },
              { upsert: true } // Create if it doesn't exist
          );
          console.log("Updated lottery status in MongoDB.");

          // Proceed with lottery only if fees were claimed (i.e., pot size met threshold)
          if (feesClaimed) {
              isLotteryRunning = true;
              console.log(`Claimable fees threshold reached for market ${PROJECT_TOKEN_MINT_ADDRESS}! Initiating lottery round.`);

              const traders = await getTradersWallet(PROJECT_TOKEN_MINT_ADDRESS!, BAGS_API_KEY); // Pass required parameters
              console.log(`Traders fetched for market: ${traders.length}`, traders);
              if (traders.length === 0) {
                  console.warn("No traders in the last 24 hours. Resetting pot and waiting for next round.");
                  currentPotSize = 0;
                  isLotteryRunning = false;
                  return;
              }
              console.log(`Found ${traders.length} traders for the lottery.`);

              // Request VRF and proceed with the rest of the lottery logic
              await requestVRF().then(async (vrfResult: { transactionSignature: string; randomnessAccount: PublicKey }) => {
                  // Consume the randomness from the VRF
                  const randomValue = await consumeRandomness(vrfResult.randomnessAccount);
                  
                  // Convert the random value (BN) to a number and ensure it's within the valid range
                  const winnerIndex = randomValue.mod(new BN(traders.length)).toNumber();
                  const winner = new PublicKey(traders[winnerIndex]); // Convert winner string to PublicKey

                  console.log(`VRF result consumed from randomness account: ${vrfResult.randomnessAccount.toBase58()}`);
                  console.log(`Random value: ${randomValue.toString()}`);
                  console.log(`Winner selected: ${winner.toString()}`);

                  // Pass winner and other details to processLottery 
                  await processLottery(winner, currentPotSize);
              }).catch((err) => {
                  console.error("Lottery processing failed:", err);
                  throw new Error(`Failed to process lottery: ${err instanceof Error ? err.message : 'Unknown error'}`);
              });
          }
      } catch (error) {
          console.error(`Error in main loop for market ${PROJECT_TOKEN_MINT_ADDRESS}:`, error);
      }
  }, CHECK_INTERVAL_MS);
}

// Start the worker
mainLoop();