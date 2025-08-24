import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  TransactionSignature,
  SystemProgram,
} from "@solana/web3.js";
import {
  AnchorUtils,
  ON_DEMAND_DEVNET_PID,
  Queue,
  Randomness,
} from "@switchboard-xyz/on-demand";
import BN from "bn.js";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ debug: true });

// Load IDL
const idl = (() => {
  const idlPath = path.resolve(__dirname, "../sb-randomness/target/idl/sb_randomness.json");
  console.log(`Loading IDL from: ${idlPath}`);
  if (!fs.existsSync(idlPath)) {
    throw new Error("IDL file not found. Run `anchor build` in sb-randomness directory.");
  }
  try {
    return require(idlPath);
  } catch (err) {
    throw new Error(`Failed to load IDL from ${idlPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
})();

// Load private key
const privateKey = (() => {
  console.log("Loading PRIVATE_KEY from .env");
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error("PRIVATE_KEY not set in .env");
  if (key.startsWith("./") || key.endsWith(".json")) {
    const keyPath = path.resolve(__dirname, "..", key);
    console.log(`Loading private key from file: ${keyPath}`);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`Private key file not found at: ${keyPath}`);
    }
    return JSON.parse(fs.readFileSync(keyPath, "utf8"));
  }
  return JSON.parse(key);
})();
if (!Array.isArray(privateKey) || privateKey.length !== 64) {
  throw new Error("Invalid private key: must be a 64-byte array");
}

// Initialize connection and provider
console.log("Initializing Solana connection...");
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const workerKeypair = Keypair.fromSecretKey(Uint8Array.from(privateKey));
const wallet = new anchor.Wallet(workerKeypair);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
const payer = wallet.payer;

// Switchboard and Lottery program setup
const sbQueue = new PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7"); // Verified Devnet queue
const sbProgramId = new PublicKey(ON_DEMAND_DEVNET_PID);
let sbProgram: anchor.Program;
let queueAccount: Queue;
let LotteryProgram: anchor.Program;
let LotteryProgramId: PublicKey;

// Sleep helper
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function initializeVRF() {
  console.log("Initializing Switchboard program...");
  sbProgram = await anchor.Program.at(sbProgramId, provider);
  
  // Check wallet balance
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Wallet ${payer.publicKey.toBase58()} balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    throw new Error("Insufficient wallet balance. Need at least 0.1 SOL.");
  }

  try {
    queueAccount = new Queue(sbProgram, sbQueue);
    await queueAccount.loadData(); // Verify queue exists
    console.log(`Queue ${sbQueue.toBase58()} loaded successfully.`);
  } catch (err) {
    throw new Error(`Failed to load Switchboard queue ${sbQueue.toBase58()}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const keypairPath = path.resolve(__dirname, "../sb-randomness/target/deploy/sb_randomness-keypair.json");
  console.log(`Loading program keypair from: ${keypairPath}`);
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`Program keypair not found at: ${keypairPath}`);
  }
  const [, keypair] = await AnchorUtils.initWalletFromFile(keypairPath);
  LotteryProgramId = keypair.publicKey;

  if (idl.address !== LotteryProgramId.toBase58()) {
    console.warn(`IDL program ID (${idl.address}) doesn't match deployed program ID (${LotteryProgramId.toBase58()})`);
  }
  LotteryProgram = new anchor.Program(idl as anchor.Idl, provider);
  console.log("VRF initialization completed.");
}

export async function waitForFulfillment(randomnessAccount: PublicKey, maxRetries = 30, delayMs = 5000): Promise<boolean> {
  if (!sbProgram) throw new Error("VRF not initialized. Call initializeVRF first.");
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const randomness = new Randomness(sbProgram, randomnessAccount);
      const data = await randomness.loadData();
      if (data.currentRound?.result && !data.currentRound.result.every((byte: number) => byte === 0)) {
        console.log(`Randomness fulfilled on attempt ${attempt}`);
        return true;
      }
      console.log(`Attempt ${attempt}/${maxRetries}: Randomness not fulfilled, waiting ${delayMs}ms...`);
      await sleep(delayMs);
    } catch (err) {
      console.warn(`Attempt ${attempt}: Error checking fulfillment:`, err);
      await sleep(delayMs);
    }
  }
  console.error(`Randomness not fulfilled after ${maxRetries} attempts`);
  return false;
}

export async function requestVRF(): Promise<{
  transactionSignature: TransactionSignature;
  randomnessAccount: PublicKey;
  randomnessKeypair: Keypair;
}> {
  if (!sbProgram || !queueAccount) throw new Error("VRF not initialized.");
  
  console.log("Requesting VRF...");
  const rngKp = Keypair.generate();
  console.log(`Generated randomness account: ${rngKp.publicKey.toBase58()}`);
  let randomness: Randomness;
  let createIx;
  try {
    console.log("Creating randomness account...");
    [randomness, createIx] = await Randomness.create(sbProgram, rngKp, sbQueue);
    console.log(`Randomness account created: ${randomness.pubkey.toBase58()}`);
  } catch (err) {
    console.error(`Failed to create randomness account ${rngKp.publicKey.toBase58()}:`, err);
    throw new Error(`Failed to create randomness account: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fund randomness account for rent exemption
  const rentExemption = await connection.getMinimumBalanceForRentExemption(1024); // Estimate for randomness account
  console.log(`Funding randomness account ${rngKp.publicKey.toBase58()} with ${rentExemption / LAMPORTS_PER_SOL} SOL`);
  const fundIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: rngKp.publicKey,
    lamports: rentExemption,
  });

  // Send transaction to create and fund randomness account
  let createSignature: TransactionSignature;
  try {
    console.log("Sending create transaction...");
    const createTx = new Transaction().add(fundIx, createIx);
    createSignature = await sendAndConfirmTransaction(connection, createTx, [payer, rngKp], {
      commitment: "confirmed",
      skipPreflight: false,
      maxRetries: 5,
    });
    console.log(`Randomness account created on-chain: Signature=${createSignature}`);
  } catch (err) {
    console.error(`Failed to create randomness account on-chain ${rngKp.publicKey.toBase58()}:`, err);
    if (err instanceof Error && "logs" in err) {
      console.error("Create transaction logs:", (err as any).logs || "No logs available");
    }
    throw new Error(`Failed to create randomness account on-chain: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Verify randomness account exists
  try {
    const accountInfo = await connection.getAccountInfo(rngKp.publicKey, { commitment: "confirmed" });
    if (!accountInfo) {
      throw new Error(`Randomness account ${rngKp.publicKey.toBase58()} not found after create transaction`);
    }
    console.log(`Randomness account ${rngKp.publicKey.toBase58()} exists with ${accountInfo.data.length} bytes of data`);
    console.log(`Randomness account owner: ${accountInfo.owner.toBase58()}`);
  } catch (err) {
    console.error(`Failed to verify randomness account ${rngKp.publicKey.toBase58()}:`, err);
    throw err;
  }

  // Generate commit instruction
  let commitIx;
  try {
    console.log("Generating commit instruction...");
    commitIx = await randomness.commitIx(sbQueue);
    console.log("Commit instruction generated successfully.");
  } catch (err) {
    console.error(`Failed to generate commit instruction for randomness account ${rngKp.publicKey.toBase58()}:`, err);
    throw new Error(`Failed to generate commit instruction: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Send commit transaction
  let commitSignature: TransactionSignature;
  try {
    console.log(`Sending commit transaction with signer: payer=${payer.publicKey.toBase58()}`);
    const commitTx = new Transaction().add(commitIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    commitTx.recentBlockhash = blockhash;
    commitTx.feePayer = payer.publicKey;
    commitSignature = await connection.sendTransaction(commitTx, [payer], {
      skipPreflight: false,
    });
    console.log(`Commit transaction sent: Signature=${commitSignature}`);
    await connection.confirmTransaction(
      { signature: commitSignature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    console.log(`VRF requested: Signature=${commitSignature}, Randomness Account=${randomness.pubkey.toBase58()}`);
  } catch (err) {
    console.error(`Commit transaction failed for randomness account ${rngKp.publicKey.toBase58()}:`, err);
    if (err instanceof Error && "logs" in err) {
      console.error("Commit transaction logs:", (err as any).logs || "No logs available");
    }
    throw new Error(`VRF commit transaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { transactionSignature: commitSignature, randomnessAccount: randomness.pubkey, randomnessKeypair: rngKp };
}

export async function revealRandomness(randomnessAccount: PublicKey): Promise<string> {
  if (!sbProgram) throw new Error("VRF not initialized.");
  console.log(`Revealing randomness for account: ${randomnessAccount.toBase58()}`);
  const randomness = new Randomness(sbProgram, randomnessAccount);
  const revealIx = await randomness.revealIx();
  const transaction = new Transaction().add(revealIx);
  const signature = await sendAndConfirmTransaction(connection, transaction, [payer], {
    commitment: "confirmed",
    maxRetries: 5,
  });
  console.log(`Randomness revealed: Signature=${signature}`);
  return signature;
}

export async function consumeRandomness(randomnessAccount: PublicKey): Promise<typeof BN.prototype> {
  if (!sbProgram) throw new Error("VRF not initialized.");
  console.log(`Consuming randomness from account: ${randomnessAccount.toBase58()}`);
  const randomness = new Randomness(sbProgram, randomnessAccount);
  const data = await randomness.loadData();
  
  if (!data.currentRound?.result) throw new Error("Randomness not revealed.");
  const resultBuffer = data.currentRound.result;
  if (resultBuffer.every((byte: number) => byte === 0)) throw new Error("Randomness result empty.");
  
  const randomValue = new BN(resultBuffer.slice(0, 8));
  console.log(`Consumed randomness value: ${randomValue.toString()}`);
  return randomValue;
}

export async function executeVRFWorkflow(maxRetries = 3): Promise<typeof BN.prototype> {
  console.log("Starting VRF workflow...");
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const vrfRequest = await requestVRF();
      if (!(await waitForFulfillment(vrfRequest.randomnessAccount))) {
        throw new Error("Oracle failed to fulfill randomness.");
      }
      await revealRandomness(vrfRequest.randomnessAccount);
      const randomValue = await consumeRandomness(vrfRequest.randomnessAccount);
      console.log(`VRF workflow completed: Random value=${randomValue.toString()}`);
      return randomValue;
    } catch (err) {
      console.error(`VRF attempt ${attempt} failed:`, err);
      if (attempt === maxRetries) throw new Error(`VRF workflow failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
  throw new Error("VRF workflow failed after retries.");
}

export interface TraderVolume {
  walletAddress: string;
  volumeUsd: number;
}

export function selectWinnerFromTraders(traders: TraderVolume[], randomValue: typeof BN.prototype) {
  if (!traders.length) throw new Error("No traders provided.");
  
  const weights = traders.map((trader) => Math.max(1, Math.floor(trader.volumeUsd)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const selectionValue = randomValue.mod(new BN(totalWeight)).toNumber();
  
  let cumulativeWeight = 0;
  for (let i = 0; i < traders.length; i++) {
    cumulativeWeight += weights[i];
    if (selectionValue < cumulativeWeight) {
      console.log(`Winner selected: Address=${traders[i].walletAddress}, Index=${i}, Volume=$${traders[i].volumeUsd}`);
      return { winner: traders[i].walletAddress, winnerIndex: i, totalWeight, selectionValue };
    }
  }
  
  const lastIndex = traders.length - 1;
  console.warn(`Fallback winner: Address=${traders[lastIndex].walletAddress}, Index=${lastIndex}`);
  return { winner: traders[lastIndex].walletAddress, winnerIndex: lastIndex, totalWeight, selectionValue };
}

// Initialize VRF and test workflow
(async () => {
  try {
    console.log("Starting VRF module initialization...");
    await initializeVRF();
    console.log("VRF module initialized successfully.");

    // Optional: Test the VRF workflow
    console.log("Testing VRF workflow...");
    const randomValue = await executeVRFWorkflow();
    console.log("VRF workflow test completed.");

    // Optional: Test winner selection with sample traders
    const sampleTraders: TraderVolume[] = [
      { walletAddress: "Trader1", volumeUsd: 1000 },
      { walletAddress: "Trader2", volumeUsd: 2000 },
      { walletAddress: "Trader3", volumeUsd: 3000 },
    ];
    const winner = selectWinnerFromTraders(sampleTraders, randomValue);
    console.log(`Final winner: ${winner.winner}`);
  } catch (err) {
    console.error("VRF initialization or workflow failed:", err instanceof Error ? err.message : String(err));
  }
})();