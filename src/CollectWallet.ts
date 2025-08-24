import * as dotenv from 'dotenv';
import fetch from "node-fetch";
import moment from "moment";
dotenv.config();

export interface Token {
    address: string;
    name: string;
    symbol: string;
    logo: string;
    amount: string;
    usdPrice: number;
    usdAmount: number;
    tokenType: string;
}

export interface TokenData {
    transactionHash: string;
    transactionType: string; // e.g. "buy" | "sell"
    transactionIndex: number;
    subCategory: string;
    blockTimestamp: string; // ISO date string
    blockNumber: number;
    walletAddress: string;
    pairAddress: string;
    pairLabel: string;
    exchangeAddress: string;
    exchangeName: string;
    exchangeLogo: string;
    baseToken: string;
    quoteToken: string;
    bought: Token;
    sold: Token;
    baseQuotePrice: string;
    totalValueUsd: number;
}

export interface ApiResponse {
    cursor: string;
    page: number;
    pageSize: number;
    result: TokenData[];
}

export interface TraderVolume {
    transactionHash: string;
    walletAddress: string;
    volumeUsd: number;
};

const tokenMintAddress = process.env.PROJECT_TOKEN_MINT_ADDRESS;
const topN = 10;

export async function CollectWallet(): Promise<TraderVolume[]> {
    const toDate: string = moment().utc().format();
    const fromDate: string = moment().subtract(24, "hours").utc().format();

    const walletVolumeMap: Map<string, { volumeUsd: number; transactionHash: string }> = new Map();

    try {
        const apiKey = process.env.MORALIS_API_KEY?.trim();
        if (!apiKey) {
            throw new Error("MORALIS_API_KEY not set");
        }

        let cursor: string | undefined = undefined;

        do {
            const params = new URLSearchParams({
                fromDate,
                toDate,
                order: "DESC",
                limit: "10", // you can increase limit if needed
            });
            if (cursor) params.append("cursor", cursor);

            const response = await fetch(
                `https://solana-gateway.moralis.io/token/mainnet/${tokenMintAddress}/swaps?${params.toString()}`,
                {
                    method: "GET",
                    headers: {
                        accept: "application/json",
                        "X-API-Key": apiKey,
                    },
                }
            );

            const data = await response.json() as ApiResponse;

            if (!response.ok) {
                throw new Error(`Failed to fetch swaps: ${JSON.stringify(data)}`);
            }

            // Process this batch
            data.result.forEach((swap: TokenData) => {
                if (swap.walletAddress && typeof swap.totalValueUsd === "number") {
                    const existing = walletVolumeMap.get(swap.walletAddress);

                    if (existing) {
                        walletVolumeMap.set(swap.walletAddress, {
                            volumeUsd: existing.volumeUsd + swap.totalValueUsd,
                            transactionHash: swap.transactionHash, // overwrite with latest
                        });
                    } else {
                        walletVolumeMap.set(swap.walletAddress, {
                            volumeUsd: swap.totalValueUsd,
                            transactionHash: swap.transactionHash,
                        });
                    }
                }
            });

            cursor = data.cursor; // next page
        } while (cursor);

        // Sort & return top N
        const sortedWallets: TraderVolume[] = Array.from(walletVolumeMap.entries())
            .sort((a, b) => b[1].volumeUsd - a[1].volumeUsd)
            .slice(0, topN)
            .map(([walletAddress, { volumeUsd, transactionHash }]) => ({
                walletAddress,
                volumeUsd,
                transactionHash,
            }));

        return sortedWallets;
    } catch (error) {
        console.error("Error collecting wallets:", error);

        // fallback return whatever we already collected
        if (walletVolumeMap.size > 0) {
            return Array.from(walletVolumeMap.entries())
                .sort((a, b) => b[1].volumeUsd - a[1].volumeUsd)
                .slice(0, topN)
                .map(([walletAddress, { volumeUsd, transactionHash }]) => ({
                    walletAddress,
                    volumeUsd,
                    transactionHash,
                }));
        }

        return [];
    }
}