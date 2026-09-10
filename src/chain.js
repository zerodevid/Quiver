'use strict';
// Alamat kontrak dan konstanta Robinhood Chain (chainId 4663).
// Semua diverifikasi langsung dari chain + Blockscout pada 2026-09-10.

const ADDR = {
  // Uniswap v4
  poolManager:     '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  posmV4:          '0x58daec3116aae6d93017baaea7749052e8a04fa7', // "Uniswap v4 Positions NFT" / UNI-V4-POSM
  // Uniswap v3
  npmV3:           '0x73991a25c818bf1f1128deaab1492d45638de0d3', // NonfungiblePositionManager
  // Router
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904', // mendukung V4_POSITION_MANAGER_CALL (0x14)
  dexRouter:       '0x6e2a35a7ad683cf634d91492d73bb7ff774c6919', // agregator (dagSwapTo)
  permit2:         '0x000000000022d473030f116ddee9f6b43ac78ba3',
  // Aset kuotasi yang dikenal
  usdg:            '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG, 6 desimal
  weth:            '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH9 (dipakai pool v3)
  native:          '0x0000000000000000000000000000000000000000', // ETH native = currency 0x0 di v4
};

// Aset yang kita anggap "uang" — dipakai untuk menilai posisi dan sebagai kas zap.
const QUOTES = {
  [ADDR.native]: { symbol: 'ETH',  decimals: 18, kind: 'eth' },
  [ADDR.usdg]:   { symbol: 'USDG', decimals: 6,  kind: 'usd' },
  [ADDR.weth]:   { symbol: 'WETH', decimals: 18, kind: 'eth' },
};

const TOPIC = {
  // v4 PoolManager
  modifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
  swapV4:          '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  initializeV4:    '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  // v3 NonfungiblePositionManager
  increaseLiq:     '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',
  decreaseLiq:     '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4',
  collectV3:       '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01',
  // ERC721 / ERC20
  transfer:        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  // pool v3 langsung (LP tanpa NFT manager)
  mintV3Pool:      '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  burnV3Pool:      '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
};

// v4-periphery Actions (libraries/Actions.sol)
const ACT = {
  INCREASE_LIQUIDITY: 0x00, DECREASE_LIQUIDITY: 0x01, MINT_POSITION: 0x02, BURN_POSITION: 0x03,
  INCREASE_LIQUIDITY_FROM_DELTAS: 0x04, MINT_POSITION_FROM_DELTAS: 0x05,
  SWAP_EXACT_IN_SINGLE: 0x06, SWAP_EXACT_IN: 0x07, SWAP_EXACT_OUT_SINGLE: 0x08, SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b, SETTLE_ALL: 0x0c, SETTLE_PAIR: 0x0d,
  TAKE: 0x0e, TAKE_ALL: 0x0f, TAKE_PORTION: 0x10, TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12, CLEAR_OR_TAKE: 0x13, SWEEP: 0x14, WRAP: 0x15, UNWRAP: 0x16,
};

// UniversalRouter commands (Commands.sol) — diverifikasi dari source terverifikasi di chain ini
const CMD = {
  V3_SWAP_EXACT_IN: 0x00, V3_SWAP_EXACT_OUT: 0x01, PERMIT2_TRANSFER_FROM: 0x02,
  SWEEP: 0x04, TRANSFER: 0x05, PAY_PORTION: 0x06,
  WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, PERMIT2_PERMIT: 0x0a,
  V4_SWAP: 0x10, V4_POSITION_MANAGER_CALL: 0x14, EXECUTE_SUB_PLAN: 0x21,
};

// Alamat sentinel v4-periphery (ActionConstants.sol)
const SENTINEL = {
  MSG_SENDER: '0x0000000000000000000000000000000000000001',
  ADDRESS_THIS: '0x0000000000000000000000000000000000000002',
  OPEN_DELTA: 0n,
  CONTRACT_BALANCE: 0x8000000000000000000000000000000000000000000000000000000000000000n,
};

const ABI = {
  posmV4: [
    'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
    'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)',
    'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function nextTokenId() view returns (uint256)',
    'function poolManager() view returns (address)',
  ],
  npmV3: [
    'function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
    'function increaseLiquidity(tuple(uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
    'function decreaseLiquidity(tuple(uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
    'function collect(tuple(uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
    'function burn(uint256 tokenId) payable',
    'function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function factory() view returns (address)',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
    'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
    'function refundETH() payable',
    'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  ],
  poolManager: [
    'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
    'function getLiquidity(bytes32 id) view returns (uint128)',
  ],
  stateView: [
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  ],
  poolV3: [
    'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
    'function liquidity() view returns (uint128)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function tickSpacing() view returns (int24)',
  ],
  erc20: [
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function totalSupply() view returns (uint256)',
  ],
  permit2: [
    'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  ],
  universalRouter: [
    'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  ],
  v3Factory: [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
  ],
};

module.exports = { ADDR, QUOTES, TOPIC, ACT, CMD, SENTINEL, ABI, CHAIN_ID: 4663 };
