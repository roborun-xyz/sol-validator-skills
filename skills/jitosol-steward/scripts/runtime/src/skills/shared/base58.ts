const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes:Uint8Array):string {
 let value=0n;
 for(const byte of bytes) value=(value<<8n)+BigInt(byte);
 let encoded='';
 while(value>0n) {encoded=alphabet[Number(value%58n)]+encoded;value/=58n;}
 let leading=0;for(const byte of bytes){if(byte!==0)break;leading++;}
 return '1'.repeat(leading)+encoded;
}
export function base58Decode(text:string):Uint8Array {
 let value=0n;
 for(const char of text){const digit=alphabet.indexOf(char);if(digit<0)throw new Error('Invalid base58 character');value=value*58n+BigInt(digit);}
 const bytes:number[]=[];
 while(value>0n){bytes.push(Number(value&255n));value>>=8n;}
 let leading=0;for(const char of text){if(char!=='1')break;leading++;}
 return Uint8Array.from([...new Array(leading).fill(0),...bytes.reverse()]);
}
