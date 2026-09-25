import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
export const runtime='nodejs';
export function GET(req:NextRequest){if(process.env.DEMO_MODE==='0')return new NextResponse('Not found',{status:404});const type=req.nextUrl.searchParams.get('type');const name=type==='patch'?'demo.patch':type==='pr'?'demo-pr.md':null;if(!name)return new NextResponse('Not found',{status:404});try{return new NextResponse(readFileSync(join(/*turbopackIgnore: true*/ process.cwd(),'artifacts',name),'utf8'),{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`inline; filename="${name}"`}})}catch{return new NextResponse('Run npm run demo first',{status:404})}}
