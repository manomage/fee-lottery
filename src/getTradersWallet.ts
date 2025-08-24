import * as dotenv from 'dotenv';
dotenv.config();
import moment from 'moment';

// Define the type for fetch to avoid TypeScript errors
type Fetch = typeof import('node-fetch').default;

// Define interfaces for API remarkable response and swap data
interface Swap {
  walletAddress: string;
  totalValueUsd: number;
  [key: string]: any; // Allow other properties
}

interface ApiResponse {
  cursor: string | null; // Allow null for cursor
  result: Swap[];
}

// Interface for trader volume data
interface TraderVolume {
  walletAddress: string;
  volumeUsd: number;
}

const tokenAddress = process.env.PROJECT_TOKEN_MINT_ADDRESS;
const apiKey = process.env.MORALIS_API_KEY?.trim(); // Trim to remove whitespace
console.log('tokenAddress:', tokenAddress);
console.log('apiKey:', apiKey ? '[REDACTED]' : 'undefined'); // Log redacted key for safety
if (tokenAddress && apiKey) {
  getTradersWallet(tokenAddress, apiKey, 1); // Run every 1 hour
} else {
  console.error('Error: Both PROJECT_TOKEN_MINT_ADDRESS and MORALIS_API_KEY must be set in environment variables.');
}

// Function to fetch wallets that traded a token in the last 24 hours
export async function getTradersWallet(
  tokenAddress: string,
  apiKey: string,
  intervalHours: number = 1,
  network: string = 'mainnet',
  topN: number = 10
): Promise<TraderVolume[]> {
  // Validate inputs
  if (!apiKey) {
    console.error('Error: MORALIS_API_KEY is not set in environment variables.');
    return [];
  }
  if (!tokenAddress) {
    console.error('Error: PROJECT_TOKEN_MINT_ADDRESS is not set in environment variables.');
    return [];
  }

  // Base URL for Moralis Solana API
  const baseUrl = `https://solana-gateway.moralis.io/token/${network}/${tokenAddress}/swaps`;

  // Function to fetch swaps with retry logic
  async function fetchSwaps(fromDate: string, toDate: string, cursor: string = '', retries: number = 2): Promise<ApiResponse> {
    // Dynamically import node-fetch
    const fetch = (await import('node-fetch')).default as Fetch;

    const params = new URLSearchParams({
      fromDate,
      toDate,
      order: 'DESC',
      limit: '100', // Max results per page
    });
    if (cursor) params.append('cursor', cursor);

    const options = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-Key': apiKey.trim(), // Ensure no whitespace in API key
      },
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${baseUrl}?${params.toString()}`, options);
        if (!response.ok) {
          let errorDetails = '';
          try {
            errorDetails = await response.text(); // Attempt to get error message from response body
          } catch (e) {
            errorDetails = 'No additional error details available.';
          }
          if (response.status === 401) {
            console.error(`Attempt ${attempt}: Authentication error - Invalid API key: ${errorDetails}`);
            if (attempt === retries) {
              throw new Error(`HTTP error! status: ${response.status}, details: ${errorDetails}`);
            }
            // Wait before retrying (e.g., 1 second)
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          throw new Error(`HTTP error! status: ${response.status}, details: ${errorDetails}`);
        }
        const data: unknown = await response.json();
        console.log('Raw API response:', JSON.stringify(data, null, 2)); // Log the raw response
        // Validate response structure
        if (!data) {
          throw new Error('Invalid API response: Response is null or undefined');
        }
        const responseData = data as any;
        // Allow cursor to be string or null
        if (typeof responseData.cursor !== 'string' && responseData.cursor !== null) {
          console.error('Invalid cursor:', responseData.cursor);
          throw new Error('Invalid API response: Cursor is not a string or null');
        }
        if (!Array.isArray(responseData.result)) {
          console.error('Invalid result:', responseData.result);
          throw new Error('Invalid API response: Result is not an array');
        }
        return { cursor: responseData.cursor, result: responseData.result } as ApiResponse;
      } catch (error) {
        if (attempt === retries) {
          console.error(`Error fetching swaps after ${retries} attempts:`, error);
          return { result: [], cursor: null };
        }
        console.warn(`Attempt ${attempt} failed, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    }
    return { result: [], cursor: null }; // Fallback if all retries fail
  }

  // Function to collect all wallet addresses and their trading volumes
  async function collectWallets(): Promise<TraderVolume[]> {
    const toDate: string = moment().utc().format();
    const fromDate: string = moment().subtract(24, 'hours').utc().format();
    let cursor: string = '';
    const walletVolumeMap: Map<string, number> = new Map();

    try {
      do {
        const data: ApiResponse = await fetchSwaps(fromDate, toDate, cursor);
        // Aggregate trading volume by wallet address
        data.result.forEach((swap: Swap) => {
          if (swap.walletAddress && typeof swap.totalValueUsd === 'number') {
            const currentVolume = walletVolumeMap.get(swap.walletAddress) || 0;
            walletVolumeMap.set(swap.walletAddress, currentVolume + swap.totalValueUsd);
          }
        });
        cursor = data.cursor || ''; // Use empty string if cursor is null
      } while (cursor); // Continue until cursor is empty or null

      // Sort wallets by trading volume in descending order and take top N
      const sortedWallets: TraderVolume[] = Array.from(walletVolumeMap.entries())
        .sort((a: [string, number], b: [string, number]) => b[1] - a[1]) // Sort by volume descending
        .slice(0, topN) // Take top N wallets
        .map(([walletAddress, volumeUsd]: [string, number]) => ({
          walletAddress,
          volumeUsd,
        }));

      console.log(`Found ${walletVolumeMap.size} unique wallets trading token ${tokenAddress} in the last 24 hours.`);
      console.log(`Returning top ${sortedWallets.length} wallets by trading volume.`);
      return sortedWallets;
    } catch (error) {
      console.error('Error collecting wallets:', error);
      // Return partial results if available
      if (walletVolumeMap.size > 0) {
        const sortedWallets: TraderVolume[] = Array.from(walletVolumeMap.entries())
          .sort((a: [string, number], b: [string, number]) => b[1] - a[1])
          .slice(0, topN)
          .map(([walletAddress, volumeUsd]: [string, number]) => ({
            walletAddress,
            volumeUsd,
          }));
        console.log(`Returning partial results: ${sortedWallets.length} wallets.`);
        return sortedWallets;
      }
      return [];
    }
  }

  return await collectWallets();
}

export default getTradersWallet;