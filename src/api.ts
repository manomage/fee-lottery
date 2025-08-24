import express, { Request, Response } from 'express';
import { MongoClient, Db, ObjectId } from 'mongodb';
import { CollectWallet } from './CollectWallet';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cors from 'cors';
import http from 'http';

// Load environment variables
dotenv.config();

// --- Configuration ---
const PORT = process.env.API_PORT || 4000;
const MONGO_URI = process.env.MONGO_URI!;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'fee_lottery';
const LAMPORTS_PER_SOL = 1_000_000_000;

// --- MongoDB Setup ---
let db: Db;
let mongoClient: MongoClient;

async function connectToMongoDB() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db(MONGO_DB_NAME);
    console.log('API connected to MongoDB');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

// --- Interfaces ---
interface LotteryStatus {
  _id: string;
  currentPotSize: number;
  isLotteryRunning: boolean;
  lastUpdated: Date;
}

interface LotteryReceipt {
  _id: ObjectId;
  potSize: number;
  winner: string;
  payoutTxSig: string;
  buyTxSig: string;
  burnAmount: string;
  timestamp: Date;
}

// --- Express App Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } }); // Initialize Socket.IO

app.use(cors());
app.use(bodyParser.json());

// --- Connect to MongoDB and Start Server ---
connectToMongoDB().then(() => {
  // --- Endpoints ---

  // GET /status: Fetch current lottery status
  app.get('/status', async (req: Request, res: Response) => {
    try {
      const status = await db.collection<LotteryStatus>('lotteryStatus').findOne({ _id: 'current' });
      if (!status) {
        return res.status(404).json({ error: 'Status not found' });
      }
      res.json({
        currentPotSize: status.currentPotSize / LAMPORTS_PER_SOL,
        isLotteryRunning: status.isLotteryRunning,
        lastUpdated: status.lastUpdated,
      });
    } catch (error) {
      console.error('Error fetching status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /receipts: Fetch all lottery receipts (paginated)
  app.get('/receipts', async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;

      const receipts = await db.collection<LotteryReceipt>('lotteryReceipts')
        .find({})
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      const total = await db.collection('lotteryReceipts').countDocuments();

      res.json({
        receipts,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error('Error fetching receipts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /receipts/:id: Fetch a single receipt by ID
  app.get('/receipts/:id', async (req: Request, res: Response) => {
    try {
      const receipt = await db.collection<LotteryReceipt>('lotteryReceipts').findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!receipt) {
        return res.status(404).json({ error: 'Receipt not found' });
      }
      res.json(receipt);
    } catch (error) {
      console.error('Error fetching receipt:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /stats: Basic stats
  app.get('/stats', async (req: Request, res: Response) => {
    try {
      const totalLotteries = await db.collection('lotteryReceipts').countDocuments();
      const totalBurned = await db.collection('lotteryReceipts').aggregate([
        { $group: { _id: null, total: { $sum: { $toDouble: '$burnAmount' } } } },
      ]).toArray();

      res.json({
        totalLotteries,
        totalBurned: totalBurned[0]?.total || 0,
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /history: Alias for claim history
  app.get('/history', async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;

      const receipts = await db.collection<LotteryReceipt>('lotteryReceipts')
        .find({})
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      const total = await db.collection('lotteryReceipts').countDocuments();

      res.json({
        receipts,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (error) {
      console.error('Error fetching history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET                                                                                                                                                                                                                                                                                                                                                                                                                                                             
  app.get("/leaderboard", async (_: Request, res: Response) => {
    try {
      const wallets = await CollectWallet();
      res.json(wallets);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  });

  // GET /receipts/search: Search receipts by winner or date range
  app.get('/receipts/search', async (req: Request, res: Response) => {
    try {
      const { winner, fromDate, toDate } = req.query;
      const filter: any = {};
      if (winner) filter.winner = winner as string;
      if (fromDate) filter.timestamp = { $gte: new Date(fromDate as string) };
      if (toDate) {
        filter.timestamp = { ...filter.timestamp, $lte: new Date(toDate as string) };
      }
      const results = await db.collection<LotteryReceipt>('lotteryReceipts').find(filter).toArray();
      res.json(results);
    } catch (error) {
      console.error('Error searching receipts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --- WebSocket Setup for Real-Time Updates ---
  // Live jackpot counter and winner reveal
  const statusChangeStream = db.collection<LotteryStatus>('lotteryStatus').watch([
    { $match: { operationType: { $in: ['insert', 'update', 'replace'] } } },
  ]);

  statusChangeStream.on('change', async () => {
    const status = await db.collection<LotteryStatus>('lotteryStatus').findOne({ _id: 'current' });
    if (status) {
      io.emit('status-update', {
        currentPotSize: status.currentPotSize / LAMPORTS_PER_SOL,
        isLotteryRunning: status.isLotteryRunning,
        lastUpdated: status.lastUpdated,
      });
    }
  });

  const receiptChangeStream = db.collection<LotteryReceipt>('lotteryReceipts').watch([
    { $match: { operationType: 'insert' } },
  ]);

  receiptChangeStream.on('change', async (change) => {
    if (change.operationType === 'insert') {
      const newReceipt = change.fullDocument as LotteryReceipt;
      io.emit('new-winner', {
        winner: newReceipt.winner,
        potSize: newReceipt.potSize / LAMPORTS_PER_SOL,
        timestamp: newReceipt.timestamp,
      });
    }
  });

  // Handle stream errors
  statusChangeStream.on('error', (error) => console.error('Status change stream error:', error));
  receiptChangeStream.on('error', (error) => console.error('Receipt change stream error:', error));

  // Close streams on process exit
  process.on('SIGINT', () => {
    statusChangeStream.close();
    receiptChangeStream.close();
    mongoClient.close();
    process.exit();
  });

  // WebSocket connection handling
  io.on('connection', (socket) => {
    console.log('Frontend connected');
    socket.on('disconnect', () => console.log('Frontend disconnected'));
  });

  // Global error handler
  app.use((err: Error, req: Request, res: Response, next: any) => {
    console.error('Global error:', err);
    res.status(500).json({ error: 'Unexpected error occurred' });
  });

  // Start server
  server.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
  });
});
