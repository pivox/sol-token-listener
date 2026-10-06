import assert from 'node:assert/strict';
import test from 'node:test';
import { getAssociatedTokenAddressSync, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { PumpSwapDirectPoolVenueReader } from '../src/live/pumpswap-direct-pool-resolver.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PUMPSWAP_ACCOUNTS } from '../src/markets/pumpswap/generated/pumpswap-idl.js';
import { poolPda } from '../src/markets/pumpswap/official-sdk.js';
import { pumpPoolAuthorityPda } from '../src/launchpads/pumpfun/official-sdk.js';
import type { MarketRpcReader, ReadonlyAccountSnapshot } from '../src/ports/market-rpc-reader.js';
import { accounts, MINT } from './helpers/pumpfun-paper-quote-state.js';

void test('direct canonical pool reader resolves a migrated mint with no pool-index record', async () => {
  const fixture=await directFixture();
  const rpc=new FixtureReader(fixture.values);
  const reader=new PumpSwapDirectPoolVenueReader(rpc,()=>1_800_000_000_000,'finalized');
  const state=await reader.read(MINT.toBase58());
  assert.equal(rpc.calls.length,2,'one canonical PDA discovery read then one coherent pool/vault/mint validation read');
  assert.equal(state.pumpSwap?.pool.address,fixture.pool.toBase58());
  assert.equal(state.pumpSwap?.pool.creator,fixture.creator.toBase58(),'Pool::creator is the Pump pool-authority PDA, not coin_creator.');
  assert.equal(state.resolutionSource,'RPC_CANONICAL_PDA');
  assert.equal(state.resolutionSlot,55n);
  assert.equal(state.resolutionAtMs,1_800_000_000_000);
  assert.equal(state.pumpSwapCashback,true);
  assert.equal(state.pumpSwap?.pool.activatedAt,null,'direct account reads do not invent an activation transaction cursor');
});

void test('direct canonical pool reader fails closed on wrong canonical address and inconsistent vault', async () => {
  const fixture=await directFixture();
  const badPool=fixture.values.get(fixture.pool.toBase58());
  assert.ok(badPool);
  const wrongCreator=new PublicKey(new Uint8Array(32).fill(29));
  const wrongAddress=poolPda(0,wrongCreator,MINT,NATIVE_MINT).toBase58();
  const wrongAddressReader=new PumpSwapDirectPoolVenueReader(new FixtureReader(new Map([
    ...fixture.values,
    [fixture.pool.toBase58(),null],
    [wrongAddress,{...badPool,address:wrongAddress}],
  ])),()=>1_800_000_000_000);
  assert.equal((await wrongAddressReader.read(MINT.toBase58())).pumpSwap,null);

  const vault=fixture.values.get(fixture.baseVault.toBase58());
  assert.ok(vault);
  const badValues=new Map(fixture.values);
  badValues.set(fixture.baseVault.toBase58(),{...vault,owner:PUMPSWAP_PROGRAM_ID});
  const mismatch=new PumpSwapDirectPoolVenueReader(new FixtureReader(badValues),()=>1_800_000_000_000);
  await assert.rejects(mismatch.read(MINT.toBase58()),/vault|Token Program|canonical/u);
});

interface Fixture { readonly values:Map<string,ReadonlyAccountSnapshot|null>;readonly pool:PublicKey;readonly creator:PublicKey;readonly baseVault:PublicKey }
async function directFixture():Promise<Fixture>{
  const pump=await accounts({isCashbackCoin:true,complete:true});
  const creator=pumpPoolAuthorityPda(MINT);const pool=poolPda(0,creator,MINT,NATIVE_MINT);
  const baseProgram=TOKEN_PROGRAM_ID;
  const baseVault=getAssociatedTokenAddressSync(MINT,pool,true,baseProgram);
  const quoteVault=getAssociatedTokenAddressSync(NATIVE_MINT,pool,true,TOKEN_PROGRAM_ID);
  const lpMint=new PublicKey(new Uint8Array(32).fill(33));
  const poolData=encodePool({creator,baseMint:MINT,quoteMint:NATIVE_MINT,lpMint,baseVault,quoteVault,cashback:true});
  const baseMint=pump.snapshots[3];
  if(baseMint===undefined)throw new Error('Base mint fixture missing.');
  const quoteData=Buffer.alloc(MintLayout.span);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1_000_000_000_000n,decimals:9,
    isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},quoteData);
  const values=new Map<string,ReadonlyAccountSnapshot|null>();
  for(const account of [pump.snapshots[2],baseMint])if(account!==undefined)values.set(account.address,{...account,slot:55n});
  values.set(pool.toBase58(),snapshot(pool.toBase58(),PUMPSWAP_PROGRAM_ID,poolData));
  values.set(NATIVE_MINT.toBase58(),snapshot(NATIVE_MINT.toBase58(),TOKEN_PROGRAM_ID.toBase58(),quoteData));
  values.set(baseVault.toBase58(),snapshot(baseVault.toBase58(),baseProgram.toBase58(),tokenAccount(MINT,pool,10_000n)));
  values.set(quoteVault.toBase58(),snapshot(quoteVault.toBase58(),TOKEN_PROGRAM_ID.toBase58(),tokenAccount(NATIVE_MINT,pool,20_000n)));
  return {values,pool,creator,baseVault};
}
class FixtureReader implements MarketRpcReader {
  public readonly calls:string[][]=[];
  public constructor(private readonly values:ReadonlyMap<string,ReadonlyAccountSnapshot|null>){}
  public async readAccountsAtSameSlot(addresses:readonly string[]):Promise<readonly (ReadonlyAccountSnapshot|null)[]>{
    this.calls.push([...addresses]);return addresses.map((address)=>this.values.get(address)??null);
  }
}
function snapshot(address:PublicKey|string,owner:string,data:Buffer):ReadonlyAccountSnapshot{
  return {address:typeof address==='string'?address:address.toBase58(),owner,data,lamports:10_000_000n,slot:55n};
}
function tokenAccount(mint:PublicKey,authority:PublicKey,amount:bigint):Buffer{
  const data=Buffer.alloc(165);mint.toBuffer().copy(data,0);authority.toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);data[108]=1;return data;
}
function encodePool(input:{creator:PublicKey;baseMint:PublicKey;quoteMint:PublicKey;lpMint:PublicKey;baseVault:PublicKey;quoteVault:PublicKey;cashback:boolean}):Buffer{
  const data=Buffer.alloc(300);Buffer.from(PUMPSWAP_ACCOUNTS.Pool.discriminator).copy(data,0);let at=8;
  const write=(value:Uint8Array):void=>{Buffer.from(value).copy(data,at);at+=value.length;};
  write(Uint8Array.of(1,0,0));for(const key of [input.creator,input.baseMint,input.quoteMint,input.lpMint,input.baseVault,input.quoteVault])write(key.toBytes());
  write(Uint8Array.from(le(8,1n)));write(new PublicKey(new Uint8Array(32).fill(5)).toBytes());write(Uint8Array.of(0,input.cashback?1:0));write(Uint8Array.from(le(16,0n)));
  return data;
}
function le(width:number,value:bigint):number[]{return Array.from({length:width},(_,index)=>Number((value>>BigInt(index*8))&255n));}
