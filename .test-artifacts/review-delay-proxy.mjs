import http from 'node:http';
const server=http.createServer((request,response)=>{
  const delay=request.url.startsWith('/preview/')?1800:request.url.startsWith('/user/profile')?1800:0;
  setTimeout(()=>{
    const upstream=http.request({hostname:'127.0.0.1',port:3000,path:request.url,method:request.method,headers:request.headers},result=>{
      response.writeHead(result.statusCode,result.headers);result.pipe(response);
    });
    upstream.on('error',()=>{response.writeHead(502);response.end('Local review proxy unavailable');});
    request.pipe(upstream);
  },delay);
});
server.listen(4011,'127.0.0.1',()=>console.log('Local latency review proxy: 127.0.0.1:4011'));
process.stdin.on('data',data=>{if(String(data).includes('quit'))server.close(()=>process.exit(0));});
