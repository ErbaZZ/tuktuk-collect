import Web3 from 'web3';
import abiDecoder from 'abi-decoder';
import dotenv from 'dotenv';
dotenv.config();

// ==== Config ====

const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const WEBSOCKET_PROVIDER = process.env.RPC_URL ? process.env.RPC_URL : "wss://bsc-ws-node.nariox.org:443";
const MIN_SHARE_TO_COLLECT = process.env.MIN_SHARE_TO_COLLECT ? parseFloat(process.env.MIN_SHARE_TO_COLLECT) : 100;

// ==== Connection ====

const provider = new Web3.providers.WebsocketProvider(WEBSOCKET_PROVIDER, {
    clientConfig: {
        keepalive: true,
        keepaliveInterval: 60000,
    },
    reconnect: {
        auto: true,
        delay: 10000,
        onTimeout: true,
        maxAttempts: 10
    }
});
provider.on('connect', () => {
    console.log("RPC Connected!");
});
provider.on('error', err => {
    console.log(`WSS Error: ${err.message}`);
});
provider.on('end', async (err) => {
    console.log(`WSS Connection Stopped!`);
});
const web3 = new Web3(provider);
web3.eth.accounts.wallet.add(WALLET_PRIVATE_KEY);

// ==== Addresses ====

import ContractAddress from './ContractAddress.json';
const COLLATERAL_RESERVE_ADDRESS = ContractAddress.CollateralReserve;
const POOL_ADDRESS = ContractAddress.Pool;
const TUKROUTER_ADDRESS = ContractAddress.TukTukRouter
const TUK_LP_ADDRESS = ContractAddress.TUKPair;
const BUSD_LP_ADDRESS = ContractAddress.BUSDPair;
const TUK_ADDRESS = ContractAddress.TukTukToken;
const TTUSD_ADDRESS = ContractAddress.TTUSD;
const DEPLOYER_ADDRESS = ContractAddress.TukDeployer;

// ==== ABIs ====

import collateralReserveABI from './abi/CollateralReserve.json';
import poolABI from './abi/Pool.json';
import routerABI from './abi/TukTukRouter.json';
import lpABI from './abi/TukTukPair.json';
import erc20ABI from './abi/ERC20.json';

abiDecoder.addABI(routerABI);
abiDecoder.addABI(erc20ABI);

// ==== Contracts ====

const collateralReserve = new web3.eth.Contract(collateralReserveABI, COLLATERAL_RESERVE_ADDRESS);
const pool = new web3.eth.Contract(poolABI, POOL_ADDRESS);
const router = new web3.eth.Contract(routerABI, TUKROUTER_ADDRESS);
const tukLp = new web3.eth.Contract(lpABI, TUK_LP_ADDRESS);
const busdLp = new web3.eth.Contract(lpABI, BUSD_LP_ADDRESS);
const tuk = new web3.eth.Contract(erc20ABI, TUK_ADDRESS);
const ttusd = new web3.eth.Contract(erc20ABI, TTUSD_ADDRESS);

// ==== Global Vars ====

let sharePrice;
let shareInReserve;
let shareReceivedWhenRedeem;
let collateralToCollect;
let shareToCollect;
let ttusdInWallet;
let isBeforeTransfer = false;
let isOngoing = false;
let lastGas = 0;
let myPendingTxCount = 0;

// ==== Methods ====

async function getPriceBNB() {
    const reserve = await busdLp.methods.getReserves().call();
    return reserve['_reserve1'] / reserve['_reserve0']; // 1 BNB = X BUSD
}

async function getPriceTUK() {
    const reserve = await tukLp.methods.getReserves().call();
    return reserve['_reserve1'] / reserve['_reserve0']; // 1 BNB = X TUK
}

// ** instant redeem to get the most latest TUK price before 'collectRedemption()'
async function redeem(dollarAmount, gasPrice) {
    const minCollateralAmount = 0.88 * dollarAmount;            // at least 88%
    const minShareAmount = 0.09 * dollarAmount / sharePrice;    // at least 9%

    await pool.methods.redeem(
        web3.utils.toWei(dollarAmount.toString()),
        web3.utils.toWei(minShareAmount.toString()),
        web3.utils.toWei(minCollateralAmount.toString())
    ).send({
        gas: 900000,
        gasPrice: web3.utils.toWei((gasPrice + 1).toString(), 'gwei'),
    }).on('transactionHash', function (transactionHash) {
        console.log("Submitted to mempool.");
    });
}

function collectRedemption(_gasPrice) {
    lastGas = _gasPrice;
    const gasPrice = web3.utils.toWei(_gasPrice.toString(), 'gwei');
    return pool.methods.collectRedemption().send({
        gas: 900000,
        gasPrice: gasPrice
    }).on('transactionHash', (transactionHash) => { // Tx submitted
        console.log(`Collecting Collateral and Share: https://bscscan.com/tx/${transactionHash}`);
    }).on('receipt', async (receipt) => { // Tx success
        console.log(`Collection Success!`);
        isOngoing = false;
        isBeforeTransfer = false;
        myPendingTxCount = 0;
        lastGas = 0;
    }).on('error', async (error) => { // Tx error
        console.warn(error);
        myPendingTxCount--;
        // No more pending transaction
        if (myPendingTxCount <= 0) {
            isOngoing = false;
            isBeforeTransfer = false;
            myPendingTxCount = 0;
            lastGas = 0;
        }
    }).then(() => { // After tx
        return updateBalance();
    })
}

async function updateBalance() {
    ttusdInWallet = web3.utils.fromWei(await ttusd.methods.balanceOf(WALLET_ADDRESS).call());
    collateralToCollect = web3.utils.fromWei(await pool.methods.redeem_collateral_balances(WALLET_ADDRESS).call());
    shareToCollect = web3.utils.fromWei(await pool.methods.redeem_share_balances(WALLET_ADDRESS).call());
}

async function main() {
    // TODO: in case error in mempool, manual collect here
    // await collectRedemption(10);

    await updateBalance();

    console.log('ttUSD: ' + ttusdInWallet);
    console.log('BUSD To collect: ' + collateralToCollect);
    console.log('TUK to collect: ' + shareToCollect);
    console.log('==========');

    const blockSubscription = web3.eth.subscribe('newBlockHeaders');
    const pendingSubscription = web3.eth.subscribe('pendingTransactions');

    blockSubscription.on('data', async (block, error) => {
        // No need to watch new blocks during transaction
        if (isOngoing) return;

        console.log("Block: " + block.number);
        shareInReserve = web3.utils.fromWei(await tuk.methods.balanceOf(COLLATERAL_RESERVE_ADDRESS).call());
        
        // Enough share in reserve to collect
        if (parseFloat(shareInReserve) > parseFloat(shareToCollect) && parseFloat(shareToCollect) >= MIN_SHARE_TO_COLLECT) {
            isOngoing = true;
            myPendingTxCount = 1;
            collectRedemption(10);
        }
        // Do non-required time consuming tasks to run after sending the transaction
        sharePrice = await getPriceBNB() / await getPriceTUK();
        shareReceivedWhenRedeem = (0.1 * sharePrice) * ttusdInWallet;
        console.log('TUK Price in USD: ' + sharePrice);
        // console.log('TUK when redeem now: ' + shareReceivedWhenRedeem);
        console.log('TUK Reserve Amount: ' + shareInReserve);
        console.log('==========');
    });

    pendingSubscription.on('data', (txHash) => {
        web3.eth.getTransaction(txHash).then( (pendingTx) => {
            try {
                // Ignore own transaction
                if (pendingTx.from === WALLET_ADDRESS) return;
                // Not interested in other transactions
                if (pendingTx.to !== TUK_ADDRESS && pendingTx.to !== POOL_ADDRESS) return;

                // TODO: redeem() before when DEPLOYER buy TUK to get best TUK amount
                // redeem(gasPrice + 1)

                const decodedData = abiDecoder.decodeMethod(pendingTx.input);
                const gasPrice = parseFloat(web3.utils.fromWei(pendingTx.gasPrice, 'gwei'));

                // TUK transaction
                if (pendingTx.to === TUK_ADDRESS) {
                    if (isOngoing) return;
                    // Transfer
                    if (decodedData.name !== "transfer") return;
                    // to CollateralReserve
                    if (decodedData.params[0]['value'] !== COLLATERAL_RESERVE_ADDRESS) return;

                    const tukAmount = web3.utils.fromWei(decodedData.params[1]['value']);
                    console.log("New TUK to CollateralReserve: " + tukAmount);
                    // Redeeming after 
                    if (parseFloat(tukAmount) + shareInReserve > shareToCollect && parseFloat(shareToCollect) >= MIN_SHARE_TO_COLLECT) {
                        if (!isOngoing) {
                            // Mark we must go after the transfer tx, no frontrun
                            isBeforeTransfer = true;
                            isOngoing = true;
                            myPendingTxCount = 1;
                            collectRedemption(gasPrice);
                        }
                    }
                    return;
                }
                // Pool transaction
                {
                    // No ongoing = no frontrun
                    if (!isOngoing) return;
                    // Don't frontrun transfer transaction
                    if (isBeforeTransfer) return;
                    // Frontrun collectRedemption function only
                    if (decodedData.name !== "collectRedemption") return;
                    // Do nothing when others got lower gas
                    if (gasPrice <= lastGas) return;

                    // Frontrun
                    const newGas = Math.max(gasPrice + 1, lastGas * 1.1);
                    myPendingTxCount++;
                    console.log(`Updating gas: ${lastGas} -> ${newGas}`);
                    collectRedemption(newGas);
                }

            } catch (error) {
                //console.log(error);
            }
        });
    });
}

main()
    .then(async () => {
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });