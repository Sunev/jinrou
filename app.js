var http = require('http');
var https = require('https');
var ss = require('socketstream');

ss.client.define('main',{
	view:'app.jade',
	css:['libs','app.styl'],
	code:['app','libs','pages','shared'],
	tmpl:'*',
});

ss.http.router.on('/',function(req,res){
	res.serveClient('main');
});

ss.client.formatters.add(require('ss-latest-coffee'));
ss.client.formatters.add(require('ss-jade'));
ss.client.formatters.add(require('ss-stylus'));

ss.client.templateEngine.use(require('ss-clientjade'));

ss.client.set({liveReload: false});
ss.session.store.use('redis');
ss.publish.transport.use('redis');

if(ss.env=='production')ss.client.packAssets();

//pull時にはコンフィグファイルないので・・・
try{
	global.Config=require('./config/app.coffee');
}catch(e){
	console.error("Failed to load config file.");
	console.error("Copy config.default/app.coffee to config/app.coffee, edit app.coffee, and retry.");
	console.error(e.trace || e);
	process.exit(1);
}

//---- Middleware
var middleware=require('./server/middleware.coffee');
ss.http.middleware.prepend(middleware.jsonapi);
ss.http.middleware.prepend(middleware.manualxhr);
ss.http.middleware.prepend(middleware.images);

//リッスン先设定
ss.ws.transport.use("engineio",{
	client:Config.ws.connect,
});

//---- init HTTP server
var server;
if (Config.http.secure != null){
    server = https.createServer(Config.http.secure, ss.http.middleware);
}else{
    server = http.createServer(ss.http.middleware);
}

db=require('./server/db.coffee');
db.dbinit(function () {
    server.listen(Config.http.port);
    ss.start(server);
})
