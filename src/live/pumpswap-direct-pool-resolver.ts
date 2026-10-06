import {
  AccountLayout, ExtensionType, MintLayout, NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import type { CanonicalMarketPool } from '../domain/market.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { bondingCurvePda, PUMP_SDK, pumpPoolAuthorityPda } from '../launchpads/pumpfun/official-sdk.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { decodePumpSwapPoolAccount } from '../markets/pumpswap/pool-account-decoder.js';
import { poolPda } from '../markets/pumpswap/official-sdk.js';
import { validateSupportedPumpSwapMint } from '../markets/pumpswap/pool-validator.js';
import type { CanonicalPaperVenueReader, CanonicalPaperVenueState } from '../paper/paper-quote-router.js';
import type { MarketRpcReader, ReadonlyAccountSnapshot } from '../ports/market-rpc-reader.js';

const SUPPORTED_MINT_EXTENSIONS=new Set([ExtensionType.MetadataPointer,ExtensionType.TokenMetadata]);

/** Reads the Pump canonical PDA directly. It has no dependency on the local market_pools index. */
export class PumpSwapDirectPoolVenueReader implements CanonicalPaperVenueReader {
  public readonly resolutionSource='RPC_CANONICAL_PDA' as const;
  public constructor(
    private readonly rpc:MarketRpcReader,
    private readonly now:()=>number=Date.now,
    private readonly confirmationStatus:'confirmed'|'finalized'='confirmed',
  ){}

  public async read(mintAddress:string):Promise<CanonicalPaperVenueState>{
    const mint=new PublicKey(mintAddress);
    const expectedCurve=bondingCurvePda(mint);
    const expectedCreator=pumpPoolAuthorityPda(mint);
    const expectedPool=poolPda(0,expectedCreator,mint,NATIVE_MINT);
    const initial=await this.rpc.readAccountsAtSameSlot([expectedCurve.toBase58(),mint.toBase58(),expectedPool.toBase58()]);
    if(initial.length!==3)throw new Error('Direct PumpSwap discovery returned an invalid account count.');
    const [curveAccount,mintAccount,discoveredPool]=initial;
    if(curveAccount===undefined||mintAccount===undefined||discoveredPool===undefined)throw new Error('Direct PumpSwap discovery omitted an account response.');
    const mintSnapshot=requireAccount(mintAccount,mint.toBase58(),'base mint');
    const tokenProgram=tokenProgramForMint(mintSnapshot);
    const curve=curveAccount===null?null:decodeCurve(requireAccount(curveAccount,expectedCurve.toBase58(),'bonding curve'));
    if(curve!==null&&!curve.quoteMint.equals(PublicKey.default)&&!curve.quoteMint.equals(NATIVE_MINT)){
      return unavailable(mintAddress,initial[0]?.slot??mintSnapshot.slot,'bonding curve quote mint is outside the live SOL profile',this.now());
    }
    const receivedAt=this.now();
    if(discoveredPool===null){
      if(curve===null)return unavailable(mintAddress,mintSnapshot.slot,'bonding curve and canonical pool accounts are unavailable',receivedAt);
      return Object.freeze({mint:mintAddress,bondingCurve:Object.freeze({active:!curve.complete,complete:curve.complete}),
        migrationObserved:curve.complete,pumpSwap:null,headSlot:mintSnapshot.slot,
        resolutionSource:'RPC_CANONICAL_PDA',resolutionSlot:initialSlot(initial),resolutionAtMs:receivedAt,
        resolutionError:null});
    }
    if(discoveredPool.owner!==PUMPSWAP_PROGRAM_ID){
      return unavailable(mintAddress,discoveredPool.slot,'derived canonical pool address has an unexpected owner',receivedAt);
    }
    if(curve!==null&&!curve.complete){
      return unavailable(mintAddress,discoveredPool.slot,'canonical pool exists while the bonding curve is still active',receivedAt);
    }
    const firstDecoded=decodePumpSwapPoolAccount(discoveredPool);
    if(firstDecoded.index!==0||firstDecoded.creator!==expectedCreator.toBase58()
      ||firstDecoded.baseMint!==mintAddress||firstDecoded.quoteMint!==NATIVE_MINT.toBase58()
      ||poolPda(firstDecoded.index,new PublicKey(firstDecoded.creator),mint,new PublicKey(firstDecoded.quoteMint)).toBase58()!==expectedPool.toBase58()){
      return unavailable(mintAddress,discoveredPool.slot,'derived pool account does not match the canonical Pump authority, mint, quote, and index',receivedAt);
    }
    const baseTokenProgram=tokenProgram;
    const baseVault=getAssociatedTokenAddressSync(mint,expectedPool,true,baseTokenProgram);
    const quoteVault=getAssociatedTokenAddressSync(NATIVE_MINT,expectedPool,true,TOKEN_PROGRAM_ID);
    if(firstDecoded.baseVault!==baseVault.toBase58()||firstDecoded.quoteVault!==quoteVault.toBase58()){
      return unavailable(mintAddress,discoveredPool.slot,'canonical pool vault addresses do not match their token-program ATAs',receivedAt);
    }
    const verified=await this.rpc.readAccountsAtSameSlot([expectedPool.toBase58(),mint.toBase58(),NATIVE_MINT.toBase58(),baseVault.toBase58(),quoteVault.toBase58()]);
    if(verified.length!==5)throw new Error('Direct PumpSwap validation returned an invalid account count.');
    const [poolSnapshot,baseMintSnapshot,quoteMintSnapshot,baseVaultSnapshot,quoteVaultSnapshot]=verified;
    const checkedPool=requireAccount(poolSnapshot,expectedPool.toBase58(),'canonical pool');
    if(verified.some((account)=>account!==null&&account.slot!==checkedPool.slot))throw new Error('Direct PumpSwap accounts do not share one RPC slot.');
    const decoded=decodePumpSwapPoolAccount(checkedPool);
    if(checkedPool.owner!==PUMPSWAP_PROGRAM_ID||decoded.index!==0||decoded.creator!==expectedCreator.toBase58()
      ||decoded.baseMint!==mintAddress||decoded.quoteMint!==NATIVE_MINT.toBase58()
      ||poolPda(0,expectedCreator,mint,NATIVE_MINT).toBase58()!==checkedPool.address){
      return unavailable(mintAddress,checkedPool.slot,'canonical PumpSwap pool changed or failed PDA validation during resolution',receivedAt);
    }
    const baseMint=requireAccount(baseMintSnapshot,mintAddress,'base mint');
    const quoteMint=requireAccount(quoteMintSnapshot,NATIVE_MINT.toBase58(),'wSOL quote mint');
    if(baseMint.owner!==tokenProgram.toBase58()||quoteMint.owner!==TOKEN_PROGRAM_ID.toBase58()){
      return unavailable(mintAddress,checkedPool.slot,'pool mint owner does not match its declared Token Program',receivedAt);
    }
    validateSupportedPumpSwapMint(baseMint,mintAddress,tokenProgram===TOKEN_2022_PROGRAM_ID?'TOKEN_2022':'SPL_TOKEN',SUPPORTED_MINT_EXTENSIONS);
    if(quoteMint.data.length<MintLayout.span||MintLayout.decode(Buffer.from(quoteMint.data)).decimals!==9){
      return unavailable(mintAddress,checkedPool.slot,'wSOL quote mint layout or decimals are invalid',receivedAt);
    }
    assertVault(requireAccount(baseVaultSnapshot,decoded.baseVault,'base vault'),mint,expectedPool,baseTokenProgram);
    assertVault(requireAccount(quoteVaultSnapshot,decoded.quoteVault,'quote vault'),NATIVE_MINT,expectedPool,TOKEN_PROGRAM_ID);
    const pool:CanonicalMarketPool=Object.freeze({address:checkedPool.address,market:'pumpswap',programId:checkedPool.owner,
      baseMint:decoded.baseMint,quoteAsset:Object.freeze({mint:decoded.quoteMint,decimals:9,tokenProgram:'SPL_TOKEN'}),
      index:0,creator:decoded.creator,baseVault:decoded.baseVault,quoteVault:decoded.quoteVault,lpMint:decoded.lpMint,
      baseTokenProgram:tokenProgram===TOKEN_2022_PROGRAM_ID?'TOKEN_2022':'SPL_TOKEN',activatedAt:null,
      confirmationStatus:this.confirmationStatus});
    return Object.freeze({mint:mintAddress,bondingCurve:Object.freeze({active:false,complete:true}),migrationObserved:true,
      pumpSwap:Object.freeze({active:true,pool}),headSlot:checkedPool.slot,resolutionSource:'RPC_CANONICAL_PDA',
      resolutionSlot:checkedPool.slot,resolutionAtMs:receivedAt,pumpSwapCashback:decoded.isCashbackCoin});
  }
}

function decodeCurve(account:ReadonlyAccountSnapshot):ReturnType<typeof PUMP_SDK.decodeBondingCurve>{
  if(account.owner!==PUMP_PROGRAM_ID)throw new Error('Derived bonding curve has an unexpected owner.');
  return PUMP_SDK.decodeBondingCurve(toAccountInfo(account));
}
function tokenProgramForMint(account:ReadonlyAccountSnapshot):PublicKey{
  if(account.owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;
  if(account.owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;
  throw new Error('Direct pool discovery found an unsupported base mint Token Program.');
}
function requireAccount(account:ReadonlyAccountSnapshot|null|undefined,address:string,label:string):ReadonlyAccountSnapshot{
  if(account?.address!==address)throw new Error(`Direct PumpSwap ${label} account is missing.`);
  return account;
}
function assertVault(account:ReadonlyAccountSnapshot,mint:PublicKey,authority:PublicKey,program:PublicKey):void{
  if(account.owner!==program.toBase58()||account.data.length<AccountLayout.span)throw new Error('Direct PumpSwap vault Token Program or layout is invalid.');
  const decoded=AccountLayout.decode(Buffer.from(account.data));
  if(!new PublicKey(decoded.mint).equals(mint)||!new PublicKey(decoded.owner).equals(authority))throw new Error('Direct PumpSwap vault mint or authority does not match the pool.');
}
function toAccountInfo(account:ReadonlyAccountSnapshot):AccountInfo<Buffer>{
  if(account.lamports>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Bonding curve lamports exceed SDK precision.');
  return {data:Buffer.from(account.data),executable:false,lamports:Number(account.lamports),owner:new PublicKey(account.owner),rentEpoch:0};
}
function initialSlot(accounts:readonly (ReadonlyAccountSnapshot|null)[]):bigint{
  const value=accounts.find((account)=>account!==null)?.slot;
  if(value===undefined)throw new Error('Direct PumpSwap discovery has no context slot.');
  return value;
}
function unavailable(mint:string,slot:bigint,error:string,at:number):CanonicalPaperVenueState{
  return Object.freeze({mint,bondingCurve:null,migrationObserved:true,pumpSwap:null,headSlot:slot,
    resolutionSource:'RPC_CANONICAL_PDA',resolutionSlot:slot,resolutionAtMs:at,resolutionError:error});
}
