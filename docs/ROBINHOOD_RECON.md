# Robinhood Chain / Uniswap v3 reconnaissance

Last audited: 2026-07-22, verification block `16568489` (`2026-07-22T16:27:22Z`). The live `deployment-audit` command repeats this audit at its current block; hashes below are runtime-bytecode keccak256 values, not source-code claims.

## Chain and canonical assets

Robinhood's [network documentation](https://docs.robinhood.com/chain/connecting/) confirms mainnet chain ID `4663`, ETH gas, the public RPC `https://rpc.mainnet.chain.robinhood.com`, and Blockscout. Its [token-contract page](https://docs.robinhood.com/chain/contracts/) identifies WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` and USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`; bytecode plus ERC-20 metadata were read through RPC.

## Official Uniswap v3 registry verification

Each address was matched against the [official Robinhood v3 deployment page](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments), searched in the official [deployments.json](https://developers.uniswap.org/deployments.json) feed, checked through the [Robinhood Blockscout contract API](https://robinhoodchain.blockscout.com/api), and checked with `eth_getCode` on the official RPC.

| Contract | Address | Runtime bytes | Runtime code hash |
|---|---|---:|---|
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` | 24535 | `0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739` |
| UniswapInterfaceMulticall | `0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3` | 1383 | `0xaa2f42ac8eed7b6fce9828f68d29f3734387c3508e9a71fa83068cdff475cee8` |
| TickLens | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` | 1385 | `0xbf1bb07babb013f146395ed6e1127f8f48d598f1765bc660a91d7b164cf93ff8` |
| QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` | 8273 | `0x3db0868d945e9304c9bc6a8b2181948109ea617647142f3c4083e14393496a28` |
| NonfungiblePositionManager | `0x73991a25c818bf1f1128deaab1492d45638de0d3` | 24384 | `0x0a493d1af3d0f25fed8efa205244ebee14114267a08647fc38c515c7cd6ead4f` |
| Position Descriptor | `0x6f84dae9c064ff453e5c8af51efb819f8f610225` | 752 | `0x6c57ccabb87f0ac1de9a2115c27e517cc87c3c1e3dd3ac407d1a42d19a327c86` |
| NFT Descriptor | `0x2e9d45bb7b30549f5216813ada9a6b7982c5b3ed` | 24539 | `0xdc9cfcaffd316cf35f823dc7f3db1a17e30233a1ca5b24d51f5e747f369914af` |
| SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` | 24497 | `0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9152 | `0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` | 24546 | `0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde` |

The JSON feed did not include UniversalRouter at this audit. It is nevertheless explicitly present on the official Robinhood v3 page, has verified Blockscout contract source, and has non-empty RPC bytecode. The immutable registry records this exception (`jsonRequired: false`) instead of claiming a JSON match.

Relationship reads all passed: NPM, QuoterV2, and SwapRouter02 report the factory above and canonical WETH; factory fee/tick spacings are `100→1`, `500→10`, `3000→60`, `10000→200`.

## Live read-only pool proof

Factory `getPool(WETH, USDG, fee)` returned validated, initialized pools at verification block `16568715`:

| Fee | Pool | Tick spacing | Price (USDG/WETH) | Derived TVL |
|---:|---|---:|---:|---:|
| 100 | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` | 1 | 1937.14 | $4.44m |
| 500 | `0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a` | 10 | 1936.48 | $3.75m |
| 3000 | `0xa9188730Fe85Be88ad499D7d52B099e800fB0334` | 60 | 1938.98 | $0.25m |

TVL is derived from actual pool ERC-20 balances and the USDG-paired price; raw v3 liquidity is not compared as a USD proxy.

## Execution policy

The old missing-deployment block is removed. Execution still remains disabled by configuration: `EXECUTION_ENABLED=false`, `DRY_RUN=true`, `EMERGENCY_PAUSE=true`. The registry audit must pass on every execution path. There is no official subgraph requirement; RPC logs and contract reads are used instead.
