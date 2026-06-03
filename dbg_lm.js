'use strict';
var puppeteer=require('puppeteer-core'); var path=require('path');
var CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async function(){
  var b=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--no-sandbox','--disable-dev-shm-usage','--window-size=1280,800']});
  var pg=await b.newPage(); await pg.setViewport({width:1280,height:800});
  var errs=[]; pg.on('pageerror',function(e){errs.push(String(e.message||e));});
  await pg.goto('file://'+path.resolve(__dirname,'game3d.html'),{waitUntil:'load',timeout:30000});
  await new Promise(function(r){setTimeout(r,800);});
  await pg.evaluate(function(){ if(window.__startGame) window.__startGame(); window.__ENG.world.timeOfDay=0.5; });
  async function shot(name, tx, tz, yaw, pitch, off){
    await pg.evaluate(function(a){ var W=window.__ENG.world,T=14; W.player.inCar=false;
      W.player.x=a.tx*T+T/2 + a.ox; W.player.z=a.tz*T+T/2 + a.oz; W.player.y=0;
      if(window.__setCam) window.__setCam(a.yaw,a.pitch);
    }, {tx:tx,tz:tz,yaw:yaw,pitch:pitch,ox:off[0],oz:off[1]});
    await new Promise(function(r){setTimeout(r,450);});
    await pg.screenshot({path:path.resolve(__dirname,name)});
  }
  await shot('dbg-lm-ladies.png', 18,56, Math.PI*0.5, 0.05, [-20,10]);   // look east at the row
  await shot('dbg-lm-ballpark.png', 66,50, Math.PI, 0.12, [0,30]);        // look north at the stadium
  await shot('dbg-lm-marina.png', 35,32, 0, 0.0, [0,-22]);                // look at the marina
  console.log('landmark shots done, errs',errs.length, JSON.stringify(errs.slice(0,2)));
  await b.close();
})();
