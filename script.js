// --- Constants ---
const POLYGON_MAINNET_CHAIN_ID = '137'; // Hex: 0x89
const WALLETCONNECT_PROJECT_ID = '7c8eb9739b322728d404102acd0ae02b'; // GET YOUR OWN FROM cloud.walletconnect.com
// TODO: Replace with your actual backend API endpoints
const BACKEND_VALIDATE_AUTH_URL = '/validate_auth';
const BACKEND_PREPARE_MINT_URL = '/api/prepare_mint';
const BACKEND_PREPARE_CLAIM_URL = '/api/prepare_claim';
const BACKEND_LOG_TXN_URL = '/api/log_txn';
// TODO: Add your app's icon URL for WalletConnect metadata
const APP_ICON_URL = 'https://yourdomain.com/icon.png';

// --- DOM Elements ---
const authStatusEl = document.getElementById('auth-status');
const walletInfoEl = document.getElementById('wallet-info');
const walletAddressEl = document.getElementById('wallet-address');
const chainIdEl = document.getElementById('chain-id');
const connectButton = document.getElementById('connect-button');
const actionAreaEl = document.getElementById('action-area');
const actionTitleEl = document.getElementById('action-title');
const actionButton = document.getElementById('action-button');
const statusMessageEl = document.getElementById('status-message');
const errorMessageEl = document.getElementById('error-message');
const loadingSpinner = document.getElementById('loading-spinner');

// --- State ---
let web3Provider = null;
let signer = null;
let userAddress = null;
let currentChainId = null;
let isAuthenticated = false;
let telegramUserId = null;
let telegramInitData = null; // Store the raw initData
let actionType = null; // 'mint' or 'claim'
let referrerAddress = null; // Only for 'mint'

// --- Initialize Telegram WebApp ---
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand(); // Expand the Mini App vertically
// Apply theme parameters
document.documentElement.style.setProperty('--tg-theme-bg-color', tg.themeParams.bg_color);
document.documentElement.style.setProperty('--tg-theme-text-color', tg.themeParams.text_color);
document.documentElement.style.setProperty('--tg-theme-hint-color', tg.themeParams.hint_color);
document.documentElement.style.setProperty('--tg-theme-link-color', tg.themeParams.link_color);
document.documentElement.style.setProperty('--tg-theme-button-color', tg.themeParams.button_color);
document.documentElement.style.setProperty('--tg-theme-button-text-color', tg.themeParams.button_text_color);
document.documentElement.style.setProperty('--tg-theme-secondary-bg-color', tg.themeParams.secondary_bg_color);

// --- WalletConnect Setup ---
let wcProvider = null;

async function setupWalletConnect() {
    // Check if EthereumProvider is available from the global scope (loaded via script tag)
    if (typeof window.EthereumProvider === 'undefined') {
        console.error('WalletConnect EthereumProvider not loaded. Check the script tag in index.html.');
        showError("WalletConnect library failed to load. Please refresh.");
        connectButton.disabled = true;
        return; // Stop initialization
    }
    const { EthereumProvider } = window; // Access it from window

    try {
        wcProvider = await EthereumProvider.init({
            projectId: WALLETCONNECT_PROJECT_ID,
            chains: [parseInt(POLYGON_MAINNET_CHAIN_ID, 10)], // Required chains
            showQrModal: true, // Show QR code modal
            qrModalOptions: {
                 themeMode: tg.colorScheme === 'dark' ? 'dark' : 'light' // Match TG theme
            },
            metadata: {
                name: 'rNFT Gateway',
                description: 'Mint your rNFT and claim rewards',
                url: window.location.origin, // Your app URL
                icons: [APP_ICON_URL], // Add an icon URL
            },
        });

        wcProvider.on("connect", (info) => {
            console.log("WalletConnect connected:", info);
            // WC v2 often provides chainId as number
            handleChainChanged(info.chainId);
            // Accounts might not be immediately available on 'connect', rely on 'accountsChanged' or check accounts array
             if (wcProvider.accounts && wcProvider.accounts.length > 0) {
                 handleAccountsChanged(wcProvider.accounts);
             }
        });

        wcProvider.on("accountsChanged", handleAccountsChanged);
        wcProvider.on("chainChanged", handleChainChanged); // chainId is often number here
        wcProvider.on("disconnect", handleDisconnect);
        // wcProvider.on("session_delete", handleDisconnect); // Listen for session deletion too

        console.log("WalletConnect provider initialized");

        // If already connected from a previous session, update UI
        if (wcProvider.accounts && wcProvider.accounts.length > 0) {
             console.log("WalletConnect already connected from previous session.");
             handleChainChanged(wcProvider.chainId); // Use current chainId
             handleAccountsChanged(wcProvider.accounts);
             await initializeEthersProvider(); // Initialize ethers using the existing connection
         }

    } catch (error) {
        console.error("WalletConnect Initialization failed:", error);
        showError("Failed to initialize WalletConnect. Please refresh.");
        connectButton.disabled = true;
    }
}


// --- Web3 Connection ---
async function connectWallet() {
    showLoading(true);
    clearMessages();

    if (!WALLETCONNECT_PROJECT_ID || WALLETCONNECT_PROJECT_ID === 'YOUR_WALLETCONNECT_PROJECT_ID') {
         showError("App Configuration Error: WalletConnect Project ID is missing.");
         showLoading(false);
         return;
    }

    if (!wcProvider) {
         await setupWalletConnect(); // Setup if not already done
         if(!wcProvider) { // If setup failed
             showLoading(false);
             return; // Exit if setup failed
         }
    }

    try {
        // Try connecting or check if already connected
        if (!wcProvider.accounts || wcProvider.accounts.length === 0) {
             console.log("Attempting WalletConnect connection...");
             await wcProvider.connect(); // Opens modal if not connected
             // Events 'connect', 'accountsChanged', 'chainChanged' will handle state updates
             // We also need to initialize ethers provider after connection succeeds
             if (wcProvider.accounts && wcProvider.accounts.length > 0){
                  await initializeEthersProvider();
             }
        } else {
             // Already connected, ensure ethers provider is initialized
             console.log("WalletConnect already connected.");
             if (!web3Provider) {
                 await initializeEthersProvider();
             }
             // Ensure UI reflects current state
             handleAccountsChanged(wcProvider.accounts);
             handleChainChanged(wcProvider.chainId);
        }

    } catch (error) {
        console.error("Wallet connection failed:", error);
        // Check for user rejection
        if (error.code === 4001 || error.message?.includes("User rejected") || error.message?.includes("User closed modal")) {
            showError("Connection request rejected or cancelled.");
        } else {
            showError(`Failed to connect wallet: ${error.message || 'Unknown error'}`);
        }
        await handleDisconnect(); // Clean up state
    } finally {
        showLoading(false);
    }
}

async function initializeEthersProvider() {
     if (!wcProvider || !wcProvider.accounts || wcProvider.accounts.length === 0) {
         console.warn("Cannot initialize ethers provider: WalletConnect not ready or not connected.");
         return;
     }
     try {
         // Use ethers.BrowserProvider for EIP-1193 compatibility with WalletConnect
         web3Provider = new ethers.BrowserProvider(wcProvider, 'any'); // 'any' allows network changes
         signer = await web3Provider.getSigner();
         userAddress = await signer.getAddress(); // Ensure we have the address via signer
         console.log("Ethers provider and signer initialized. Signer Address:", userAddress);
         handleAccountsChanged([userAddress]); // Update UI explicitly with signer's address
     } catch (ethersError) {
         console.error("Failed to initialize ethers provider:", ethersError);
         showError("Could not set up wallet interaction. Please try reconnecting.");
         await handleDisconnect();
     }
}


// --- Event Handlers ---
function handleAccountsChanged(accounts) {
    console.log("Event: accountsChanged", accounts);
    if (!accounts || accounts.length === 0) {
        console.log("Wallet disconnected or no accounts found.");
        handleDisconnect(); // Treat as disconnect if no accounts
    } else {
        // Always use the first account
        const newAddress = ethers.getAddress(accounts[0]); // Get checksum address
        if (newAddress !== userAddress) {
             userAddress = newAddress;
             console.log("Account changed/connected:", userAddress);
             // Re-initialize signer for the new account
             initializeEthersProvider().then(() => {
                 updateWalletUI();
                 checkActionReadiness();
             });
        } else {
             // Address hasn't changed, just ensure UI is up-to-date
             updateWalletUI();
             checkActionReadiness();
        }
    }
}

async function handleChainChanged(chainId) {
     // WalletConnect might provide number or hex string. Standardize to decimal string.
     let newChainIdDecimal;
     if (typeof chainId === 'string' && chainId.startsWith('0x')) {
          newChainIdDecimal = parseInt(chainId, 16).toString();
     } else if (typeof chainId === 'number') {
          newChainIdDecimal = chainId.toString();
     } else {
          newChainIdDecimal = chainId; // Assume it's already a decimal string if not hex/number
     }

     console.log(`Event: chainChanged - Raw: ${chainId}, Processed: ${newChainIdDecimal}`);
     currentChainId = newChainIdDecimal;

     // Update ethers provider if it exists (BrowserProvider often handles this, but good practice)
     if (web3Provider) {
          try {
               // Re-getting the signer might be necessary if the network change requires it
               // Although BrowserProvider('any') should handle network switches
               signer = await web3Provider.getSigner();
               console.log("Refreshed signer on network change.");
          } catch (err) {
               console.error("Error refreshing signer after network change:", err);
               // Potentially handle disconnection or prompt user if signer becomes invalid
          }
     }

     updateWalletUI(); // Update displayed chain ID
     checkActionReadiness(); // Check if ready for action again based on new chain
}

async function handleDisconnect() {
    console.log("Wallet disconnected.");
    userAddress = null;
    signer = null;
    web3Provider = null;
    currentChainId = null;
    // Only attempt WC disconnect if the provider exists and thinks it's connected
    if (wcProvider && wcProvider.connected) {
        try {
            await wcProvider.disconnect();
            console.log("WalletConnect session disconnected.");
        } catch (disconnectError) {
            console.error("Error during WC disconnect:", disconnectError);
        }
    }
    // Don't reset wcProvider instance immediately, allow re-connection attempt
    // wcProvider = null; // Consider if this should be reset or kept for re-connect attempt

    updateWalletUI();
    actionAreaEl.style.display = 'none'; // Hide action area
    connectButton.style.display = 'block'; // Show connect button
    connectButton.disabled = !isAuthenticated; // Only enable connect if authenticated
    clearMessages();
    checkActionReadiness(); // Update button states
}


// --- Backend Interaction ---
async function authenticateWithBackend() {
    authStatusEl.textContent = 'Authenticating...';
    showLoading(true);
    telegramInitData = tg.initData; // Store initData

    if (!telegramInitData) {
         showError("Telegram Initialization data not found. Please try launching the app from Telegram again.");
         authStatusEl.textContent = 'Authentication Failed!';
         authStatusEl.style.color = 'red';
         showLoading(false);
         connectButton.disabled = true;
         actionButton.disabled = true;
         return;
    }

    try {
        const response = await fetch(BACKEND_VALIDATE_AUTH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: telegramInitData }),
        });

        if (response.ok) {
            const data = await response.json();
            isAuthenticated = true;
            // Extract user ID if backend provides it and it's useful
            telegramUserId = data.user_id || tg.initDataUnsafe.user?.id || 'Unknown';
            authStatusEl.textContent = `Authenticated as TG User: ${telegramUserId}`;
            authStatusEl.style.color = 'green';
            console.log("Backend authentication successful.", data);
            connectButton.disabled = false; // Enable connect button now
        } else {
            const errorData = await response.json();
            throw new Error(errorData.error || `Auth failed: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error("Backend authentication failed:", error);
        showError(`Authentication Failed: ${error.message}. Please reload the app.`);
        authStatusEl.textContent = 'Authentication Failed!';
        authStatusEl.style.color = 'red';
        isAuthenticated = false;
        connectButton.disabled = true; // Keep disabled
    } finally {
        showLoading(false);
        // Setup action UI regardless of auth success, it might show errors based on params
        setupActionUI();
        // Initialize WalletConnect provider now that auth attempt is complete
        await setupWalletConnect();
        // Final readiness check
        checkActionReadiness();
    }
}

async function prepareAndExecuteTransaction(apiEndpoint, requestBody, successMessage) {
    if (!checkActionReadiness(true)) { // Pass true to suppress redundant errors shown by checkActionReadiness itself
        showError("Cannot perform action. Conditions not met."); // Generic fallback error
        return;
    }

    showLoading(true);
    clearMessages();
    actionButton.disabled = true;

    try {
        // 1. Prepare transaction via backend
        showStatus("Preparing transaction via backend...");
        const prepareResponse = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                 'Content-Type': 'application/json',
                 // Include Telegram InitData for backend validation on this specific request
                 'X-Telegram-Init-Data': telegramInitData
            },
            body: JSON.stringify(requestBody),
        });

        if (!prepareResponse.ok) {
            let errorMsg = `Prepare failed: ${prepareResponse.status} ${prepareResponse.statusText}`;
            try { // Try to get more specific error from backend response
                 const errorData = await prepareResponse.json();
                 errorMsg = errorData.error || errorMsg;
            } catch (e) { /* Ignore if response is not JSON */ }
            throw new Error(errorMsg);
        }

        const responseData = await prepareResponse.json();
        const transaction = responseData.transaction; // Assuming backend returns { transaction: { to: ..., data: ..., value: ... } }

        if (!transaction || !transaction.to || !transaction.data) {
            throw new Error("Invalid transaction parameters received from backend.");
        }
        console.log("Transaction data received:", transaction);

        // 2. Sign and send transaction via wallet
        showStatus("Please confirm the transaction in your wallet...");
        const tx = await signer.sendTransaction({
            to: transaction.to,
            data: transaction.data,
            value: transaction.value || '0x0' // Ensure value is present or defaults to 0
            // Gas parameters (gasLimit, gasPrice/maxFeePerGas) usually handled by wallet/ethers based on network
            // Backend *could* provide estimates, but often better left to wallet unless necessary
        });

        showStatus(`Transaction submitted! Hash: ${tx.hash.substring(0, 10)}... Waiting for confirmation...`);
        console.log("Transaction submitted:", tx.hash);

        // 3. Log transaction attempt to backend (optional but good practice)
        try {
             await fetch(BACKEND_LOG_TXN_URL, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({
                     txHash: tx.hash,
                     txType: actionType,
                     walletAddress: userAddress,
                     telegramUserId: telegramUserId // Send TG user ID if available
                 }),
             });
             // Ignore response unless specific error handling is needed for logging
        } catch (logError) {
             console.warn("Failed to log transaction hash to backend:", logError);
        }

        // 4. Wait for transaction confirmation
        const receipt = await tx.wait(); // Wait for 1 confirmation by default
        console.log("Transaction confirmation receipt:", receipt);

        if (receipt && receipt.status === 1) {
            showStatus(successMessage);
            tg.HapticFeedback.notificationOccurred('success');
            // Optionally provide specific feedback or UI updates based on actionType
            if (actionType === 'mint') {
                console.log("Mint successful!");
                // Maybe redirect or show a success message specific to minting
            } else if (actionType === 'claim') {
                console.log("Claim successful!");
                // Maybe refresh a reward balance display if one existed
            }
            // Close Mini App after success (optional delay)
            showStatus(successMessage + " Closing app...");
            setTimeout(() => tg.close(), 3000); // Close after 3 seconds
        } else {
            // receipt.status === 0 means the transaction was mined but failed (reverted)
             console.error("Transaction failed on-chain:", receipt);
             throw new Error("Transaction confirmed but failed (reverted) on the blockchain.");
        }

    } catch (error) {
        console.error(`${actionType} action failed:`, error);
        let displayError = error.message || "An unknown error occurred.";
        // Check for common user errors / wallet errors
        if (error.code === 4001 || error.message?.includes("User rejected") || error.message?.includes("rejected the request")) {
             displayError = "Transaction rejected by user.";
        } else if (error.code === 'INSUFFICIENT_FUNDS' || error.message?.includes("insufficient funds")) {
             displayError = "Insufficient MATIC balance for transaction gas fees.";
        } else if (error.code === 'ACTION_REJECTED') { // Ethers V6 code for user rejection during sendTransaction
             displayError = "Transaction rejected by user.";
        } else if (error.code === 'CALL_EXCEPTION') { // Ethers V6 for reverted transactions
             displayError = "Transaction failed on-chain (reverted). Check contract conditions or input.";
        } else if (error.message?.includes("execution reverted")) {
             // Fallback check for revert messages if code isn't specific
             displayError = "Transaction reverted on-chain. Check contract conditions.";
        }
        showError(`Error: ${displayError}`);
        tg.HapticFeedback.notificationOccurred('error');
        // Do NOT re-enable the button immediately on failure, let user retry if they want
        // Action button should still be disabled here. It will be re-enabled by checkActionReadiness if conditions are met again.
    } finally {
        showLoading(false);
        // Re-enable button only if conditions are still met (e.g., user didn't disconnect)
        checkActionReadiness();
    }
}

// --- Action Handlers ---
function handleMint() {
    console.log(`Attempting mint for referrer: ${referrerAddress}`);
    if (!referrerAddress || !ethers.isAddress(referrerAddress)) {
         showError("Invalid or missing referrer address for minting.");
         return;
    }
    const requestBody = {
        walletAddress: userAddress,
        referrerAddress: referrerAddress,
        // Add any other data the backend needs for minting
    };
    prepareAndExecuteTransaction(
        BACKEND_PREPARE_MINT_URL,
        requestBody,
        "rNFT Minted Successfully!"
    );
}

function handleClaim() {
    console.log("Attempting claim");
    const requestBody = {
        walletAddress: userAddress,
        // Add any other data the backend needs for claiming
    };
    prepareAndExecuteTransaction(
        BACKEND_PREPARE_CLAIM_URL,
        requestBody,
        "Rewards Claimed Successfully!"
    );
}


// --- UI Update Functions ---
function updateWalletUI() {
    if (userAddress) {
        walletAddressEl.textContent = `${userAddress.substring(0, 6)}...${userAddress.substring(userAddress.length - 4)}`;
        chainIdEl.textContent = currentChainId ? `${currentChainId}` : 'N/A'; // Display current chain ID
        walletInfoEl.style.display = 'block';
        connectButton.style.display = 'none'; // Hide connect button
    } else {
        walletInfoEl.style.display = 'none';
        connectButton.style.display = 'block'; // Show connect button
        connectButton.disabled = !isAuthenticated; // Only enable if authenticated
    }
}

function showLoading(isLoading) {
    loadingSpinner.style.display = isLoading ? 'block' : 'none';
}

function showStatus(message) {
    statusMessageEl.textContent = message;
    statusMessageEl.style.display = 'block';
    errorMessageEl.style.display = 'none'; // Hide error message
}

function showError(message) {
    errorMessageEl.textContent = message;
    errorMessageEl.style.display = 'block';
    statusMessageEl.style.display = 'none'; // Hide status message
}

function clearMessages() {
    statusMessageEl.textContent = '';
    statusMessageEl.style.display = 'none';
    errorMessageEl.textContent = '';
    errorMessageEl.style.display = 'none';
}

function setupActionUI() {
     clearMessages();
     actionAreaEl.style.display = 'none'; // Hide initially

     // Determine action from URL parameters in initData
     const startParam = tg.initDataUnsafe?.start_param;
     const urlParams = new URLSearchParams(startParam || ''); // Use empty string if no start_param

     actionType = urlParams.get('action');
     referrerAddress = urlParams.get('ref');

     // Validate referrer address immediately if present
     if (referrerAddress && !ethers.isAddress(referrerAddress)) {
          console.error(`Invalid referrer address in URL param: ${referrerAddress}`);
          showError("Invalid referral code in the link. Please use a valid link.");
          referrerAddress = null; // Invalidate it
          actionType = null; // Prevent minting attempt
     }

     // Decide default action if needed (e.g., default to mint if only ref is present)
     if (!actionType && referrerAddress) {
          actionType = 'mint';
     } else if (!actionType && !referrerAddress) {
          // No action specified and no referrer. Decide behavior.
          // Option 1: Default to mint (but it will fail without referrer later)
          // actionType = 'mint';
          // Option 2: Show an info message / hide action area
          console.warn("No specific action (mint/claim) or referrer found in start parameters.");
          actionAreaEl.style.display = 'none';
          // Optionally show a generic message:
          // showStatus("Connect your wallet to see available actions.");
          return; // Exit setup early if no action is determined
     }


     console.log(`Determined Action: ${actionType}, Referrer: ${referrerAddress}`);

     let actionPossible = false;
     if (actionType === 'mint') {
         if (referrerAddress) {
             actionTitleEl.textContent = 'Mint Your rNFT';
             actionButton.textContent = 'Mint Now';
             actionButton.onclick = handleMint;
             actionPossible = true;
         } else {
             showError("Referral code missing or invalid in the link. Cannot mint.");
             actionPossible = false;
         }
     } else if (actionType === 'claim') {
         actionTitleEl.textContent = 'Claim Rewards';
         actionButton.textContent = 'Claim Now';
         actionButton.onclick = handleClaim;
         actionPossible = true;
     } else {
         console.warn(`Unrecognized action type: ${actionType}`);
         showError("Invalid action specified in the link.");
         actionPossible = false;
     }

     actionAreaEl.style.display = actionPossible ? 'block' : 'none';

     // Don't call checkActionReadiness here directly, it will be called after auth and connect events.
}


/**
 * Checks if all conditions are met to enable the action button.
 * @param {boolean} suppressErrors - If true, don't show new error messages (used when called from within error-handling flows).
 * @returns {boolean} - True if the action button should be enabled, false otherwise.
 */
function checkActionReadiness(suppressErrors = false) {
    let isReady = false;
    let reason = ""; // For logging

    // 1. Check Authentication
    if (!isAuthenticated) {
        reason = "Not authenticated";
    }
    // 2. Check Wallet Connection
    else if (!userAddress || !signer) {
        reason = "Wallet not connected or signer not ready";
    }
    // 3. Check Network Chain ID
    else if (currentChainId !== POLYGON_MAINNET_CHAIN_ID) {
        reason = `Wrong network (Connected: ${currentChainId}, Required: ${POLYGON_MAINNET_CHAIN_ID})`;
        if (!suppressErrors) {
            showError(`Please switch to Polygon Mainnet (Chain ID: ${POLYGON_MAINNET_CHAIN_ID})`);
        }
    }
    // 4. Check Action Type and associated requirements (e.g., referrer for mint)
    else if (actionType === 'mint' && !referrerAddress) {
        reason = "Mint action requires a valid referrer address";
        // Error should have been shown by setupActionUI
    } else if (actionType !== 'mint' && actionType !== 'claim') {
        reason = `Invalid action type: ${actionType}`;
        // Error should have been shown by setupActionUI
    }
    // 5. All checks passed
    else {
        isReady = true;
        reason = "Ready";
        // Clear potential network error if now on the correct network
        if (errorMessageEl.textContent.includes("Please switch to Polygon Mainnet")) {
            clearMessages();
        }
    }

    console.log(`Action Readiness Check: ${isReady}. Reason: ${reason}`);
    actionButton.disabled = !isReady;

    // Return the readiness state, useful for prepareAndExecuteTransaction check
    return isReady;
}


// --- Initial Execution ---
document.addEventListener('DOMContentLoaded', () => {
    // Start backend authentication first
    authenticateWithBackend();

    // Add listener for the connect button
    connectButton.addEventListener('click', connectWallet);

    // Initial UI state
    showLoading(false);
    actionAreaEl.style.display = 'none';
    walletInfoEl.style.display = 'none';
    connectButton.style.display = 'block';
    connectButton.disabled = true; // Disabled until authenticated
});