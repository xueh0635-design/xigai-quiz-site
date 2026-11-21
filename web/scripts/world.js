(() => {
  "use strict";

  const themes = {
    dawn: { top: "#8987ca", horizon: "#ffd3ac", haze: "#eaa2ac", ridge: "#847ba9", sun: "#ffebb6", light: "#ffd6af", fill: "#ad9dbf", strength: .43, stars: .13, moon: 0, sunX: .21, sunY: .625, lightX: -.91 },
    day: { top: "#7fbac7", horizon: "#fff0cd", haze: "#c2dbe3", ridge: "#80a4a1", sun: "#fff6ce", light: "#ffead0", fill: "#cfdaeb", strength: .61, stars: 0, moon: 0, sunX: .80, sunY: .86, lightX: -.35 },
    dusk: { top: "#4d4b87", horizon: "#f5bc9e", haze: "#a084a2", ridge: "#766b98", sun: "#ffe0a4", light: "#ffd4a7", fill: "#9d91c6", strength: .34, stars: .33, moon: 0, sunX: .88, sunY: .63, lightX: .87 },
    night: { top: "#171b3a", horizon: "#5a5987", haze: "#373a66", ridge: "#494e7b", sun: "#d7e4ff", light: "#c9d4fd", fill: "#828cce", strength: .12, stars: 1, moon: 1, sunX: .78, sunY: .825, lightX: .44 },
  };
  const tau = Math.PI * 2;
  const origin = [0, 0, .58];
  const baseYaw = .39;
  const numbers = (hex) => hex.slice(1).match(/../g).map((pair) => parseInt(pair, 16) / 255);
  const color = (hex) => numbers(hex).map((channel) => channel ** 2.2);
  const scale = (a, factor) => a.map((channel) => channel * factor);
  const mix = (a, b, amount) => a.map((channel, index) => channel + (b[index] - channel) * amount);
  const add = (a, b) => a.map((value, index) => value + b[index]);
  const difference = (a, b) => a.map((value, index) => value - b[index]);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const unit = (v) => scale(v, 1 / (Math.hypot(...v) || 1));
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const lerp = (a, b, progress) => a + (b - a) * progress;

  function randomSource(seed) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function mesh() {
    const vertices = [];
    function triangle(a, b, c, tint, glow = 0, marker = 0) {
      const normal = unit(cross(difference(b, a), difference(c, a)));
      for (const vertex of [a, b, c]) vertices.push(...vertex, ...normal, ...tint, glow, marker);
    }
    function quad(a, b, c, d, tint, glow = 0) {
      triangle(a, b, c, tint, glow);
      triangle(a, c, d, tint, glow);
    }
    return { vertices, triangle, quad };
  }

  function tube(out, bottom, top, radiusA, radiusB, sides, tint, ends = tint, orientation = 0) {
    const axis = unit(difference(top, bottom));
    const reference = Math.abs(axis[1]) < .9 ? [0, 1, 0] : [0, 0, 1];
    const first = unit(cross(reference, axis));
    const second = cross(axis, first);
    const circumference = (angle) => add(scale(first, Math.cos(angle)), scale(second, Math.sin(angle)));
    for (let side = 0; side < sides; side += 1) {
      const angle = side * tau / sides + orientation;
      const left = circumference(angle);
      const right = circumference(angle + tau / sides);
      const a = add(bottom, scale(left, radiusA));
      const b = add(bottom, scale(right, radiusA));
      const c = add(top, scale(right, radiusB));
      const d = add(top, scale(left, radiusB));
      out.quad(a, b, c, d, scale(tint, .83 + .19 * (side % 3) / 2));
      if (radiusB) out.triangle(top, d, c, ends);
    }
  }

  function stone(out, center, radius, height, tint, random) {
    const sides = 5 + Math.floor(random() * 3);
    const bottom = [];
    const middle = [];
    const peak = add(center, [(random() - .5) * radius * .48, height, (random() - .5) * radius * .4]);
    for (let side = 0; side < sides; side += 1) {
      const angle = tau * side / sides;
      const span = radius * (.8 + random() * .26);
      const offset = [Math.sin(angle) * span, .01, Math.cos(angle) * span];
      bottom.push(add(center, offset));
      middle.push(add(center, [offset[0] * .76, height * (.55 + .25 * random()), offset[2] * .76]));
    }
    for (let side = 0; side < sides; side += 1) {
      const next = (side + 1) % sides;
      out.quad(bottom[side], bottom[next], middle[next], middle[side], scale(tint, .78 + .3 * random()));
      out.triangle(middle[side], middle[next], peak, scale(tint, .90 + .23 * random()));
    }
  }

  function flatRibbon(out, points, halfWidth, tints) {
    for (let i = 0; i < points.length - 1; i += 1) {
      const sideDirection = (index) => {
        const direction = difference(points[Math.min(index + 1, points.length - 1)], points[Math.max(index - 1, 0)]);
        return scale(unit([direction[2], 0, -direction[0]]), halfWidth * (.93 + .06 * Math.cos(i)));
      };
      const a = sideDirection(i);
      const b = sideDirection(i + 1);
      out.quad(add(points[i], a), add(points[i], scale(a, -1)),
        add(points[i + 1], scale(b, -1)), add(points[i + 1], b), tints[i % tints.length]);
    }
  }

  function floor(out, random, variant) {
    const grass = ["#769583", "#88a48d", "#98aa91", "#9ca88a", "#859984", "#a1af92"].map(color);
    const rim = ["#847888", "#a49199", "#907e8c", "#baaaa0"].map(color);
    const steps = 36;
    const profile = Array.from({length: steps}, (_, i) => 1 + .053 * Math.sin(i * 1.7) + (random() - .5) * .055);
    const radii = [0, 1.38, 2.5, 3.82, 5.03, 5.38, 4.85, 3.33];
    const levels = [.025, .035, -.018, -.087, -.14, -.41, -.91, -1.54];
    const rings = radii.map((radius, ring) => Array.from({length: steps}, (_, i) => {
      const angle = tau * i / steps + (ring % 2) * .027;
      const pathRadius = radius * profile[i];
      return [Math.cos(angle) * pathRadius * 1.05,
        levels[ring] + (ring > 4 ? (random() - .5) * .24 : .056 * Math.sin(angle * 3 + ring)),
        Math.sin(angle) * pathRadius * .84 + .2];
    }));
    for (let ring = 0; ring < rings.length - 1; ring += 1) {
      for (let i = 0; i < steps; i += 1) {
        const next = (i + 1) % steps;
        const palette = ring < 4 ? grass : rim;
        const a = rings[ring][i], b = rings[ring][next], c = rings[ring + 1][next], d = rings[ring + 1][i];
        out.triangle(a, b, c, palette[Math.floor(random() * palette.length)]);
        out.triangle(a, c, d, palette[Math.floor(random() * palette.length)]);
      }
    }
    const clay = ["#c6b38f", "#ccb995", "#b7aa8c"].map(color);
    const path = variant === "route"
      ? [[-.6,.09,3.6],[-1.15,.09,2.35],[-.62,.10,1.4],[.08,.11,.6],[1.1,.12,-.22],[1.9,.11,-1.35],[1.85,.11,-2.53],[2.62,.10,-3.25]]
      : [[-3.4,.02,2.52],[-2.25,.11,1.95],[-1.12,.10,1.31],[0,.12,.58],[1.17,.11,.07],[2.13,.11,-.96],[3.4,.07,-1.55]];
    flatRibbon(out, path, variant === "route" ? .51 : .48, clay);
    const stream = [[-4.85,-.10,.1],[-3.87,.02,-.8],[-2.62,.02,-1.02],[-1.76,.03,-1.55],[-.35,.04,-2.6],[.83,.05,-2.88],[2.03,.01,-3.81]];
    flatRibbon(out, stream, .33, ["#86b8bc", "#9cc8c7", "#74acca"].map(color));
  }

  function tree(out, x, z, height, variant) {
    const front = [x, -.08, z];
    const trunks = color("#684f5b");
    tube(out, front, add(front, [0, height * .75, 0]), height * .046, height * .024, 6, trunks);
    const palettes = [
      ["#487b76", "#57887b", "#6b9987"], ["#50807a", "#639080", "#81a28b"], ["#50727a", "#5e8284", "#70918d"],
    ];
    const greens = palettes[variant % palettes.length].map(color);
    for (let tier = 0; tier < 3; tier += 1) {
      const y = height * (.21 + tier * .22);
      const bottom = add(front, [.04 * tier, y, 0]);
      const top = add(front, [-.014 * tier, y + height * .37, .02 * tier]);
      tube(out, bottom, top, height * (.235 - tier * .048), .013, 7, greens[tier], greens[tier], tier * .29);
    }
  }

  function tent(out, x, z, tint) {
    const p = (dx, y, dz) => [x + dx, y + .01, z + dz];
    const left = color(tint);
    const right = scale(left, .73);
    const seam = color("#f1dbc1");
    const shadow = color("#67566d");
    const a = p(-.83,0,-.62), b = p(.83,0,-.62), c = p(-.85,0,.60), d = p(.85,0,.60);
    const front = p(.08,1.28,.59), back = p(.05,1.28,-.61);
    out.quad(a, c, front, back, left);
    out.quad(d, b, back, front, right);
    out.triangle(c, d, front, scale(left, 1.07));
    out.triangle(b, a, back, right);
    out.triangle(p(-.36,.01,.613), p(.43,.015,.613), p(.055,.88,.611), shadow);
    out.triangle(p(-.12,.012,.618), p(.43,.018,.618), p(.055,.88,.616), color("#886c78"));
    tube(out, c, front, .026, .026, 5, seam);
    tube(out, d, front, .026, .026, 5, seam);
    tube(out, front, back, .022, .022, 5, seam);
    tube(out, p(-1.12,.035,.83), p(-.52,.53,.54), .009, .009, 4, seam);
    tube(out, p(1.2,.02,.81), p(.54,.49,.55), .009, .009, 4, seam);
    const pad = color("#ac7d6e");
    out.quad(p(-.50,.023,.62),p(-.42,.023,.99),p(.48,.023,.97),p(.5,.023,.62),pad);
  }

  function log(out, a, b, radius, bark, rings) {
    tube(out, a, b, radius, radius * .85, 8, bark, rings);
    const axis = unit(difference(b, a));
    tube(out, b, add(b, scale(axis, .011)), radius * .59, radius * .57, 9, scale(rings, .79), scale(rings, 1.04));
    tube(out, add(b, scale(axis, .010)), add(b, scale(axis, .013)), radius * .3, radius * .29, 7, scale(rings, .83), scale(rings, .8));
  }

  function decoration(out, random) {
    const rock = ["#8b8493", "#a494a0", "#9caaa8"].map(color);
    const greens = ["#4d7f74", "#80a094", "#64897f"].map(color);
    for (let i = 0; i < 48; i += 1) {
      const angle = i * 2.4;
      const r = 2 + random() * 2.75;
      const x = Math.sin(angle) * r, z = Math.cos(angle) * r * .77;
      if (z > 1.6 && Math.abs(x) < 1.85) continue;
      if (i % 4 === 0) {
        stone(out, [x,-.055,z], .13 + random() * .25, .09 + random() * .31, rock[i % rock.length], random);
      } else {
        const tint = greens[i % greens.length];
        const stem = [x,-.019,z];
        for (let q = 0; q < 4; q += 1) {
          const turn = q * 1.8 + random() * .2;
          out.triangle(add(stem, [-.035,.01,.007]), add(stem, [.043,.012,-.009]),
            add(stem, [Math.cos(turn) * .155,.079 + random() * .13,Math.sin(turn) * .155]), scale(tint, .87 + random() * .19));
        }
      }
    }
  }

  function campsite(out, random) {
    tent(out, -2.37, -.82, "#dbaaa3");
    tent(out, 1.7, -2.03, "#b9a1bf");
    const bark = color("#72576b");
    const rings = color("#ba886e");
    const stoneColors = ["#9791a2", "#a99ba1", "#858698", "#b4a5a9"].map(color);
    for (let i = 0; i < 10; i += 1) {
      const angle = i * tau / 10;
      stone(out, add(origin, [Math.sin(angle) * .75,.09,Math.cos(angle) * .73]), .23 + random() * .08,
        .22 + random() * .12, stoneColors[i % stoneColors.length], random);
    }
    tube(out, add(origin,[0,.09,0]), add(origin,[0,.127,0]), .69, .68, 14, color("#635968"));
    for (const [a,b] of [
      [[-.47,.19,-.23],[.46,.23,.30]],
      [[-.41,.26,.42],[.36,.25,-.41]],
      [[-.48,.32,.1],[.34,.32,.15]],
    ]) log(out, add(origin,a), add(origin,b), .115, bark, rings);
    log(out, [-1.62,.05,1.76], [-1.65,.46,1.76], .40, bark, rings);
    log(out, [1.67,.035,1.50], [1.68,.42,1.53], .39, bark, rings);
    log(out, [1.45,.16,.58], [2.46,.16,1.22], .174, bark, rings);
    for (const pos of [[-1.31,.5,1.92],[1.51,.46,1.55]]) {
      tube(out, pos, add(pos,[0,.20,0]), .087, .103, 8, color("#dfb79c"));
    }
    for (const led of [[-.62,0,1.42],[2.25,0,.48],[-3.15,0,.71]]) {
      const light = color("#fff2bd");
      const center = add(led, [0,.28,0]);
      tube(out, led, add(led,[0,.29,0]), .052, .042, 5, bark);
      out.triangle(add(center,[-.095,0,0]),add(center,[.095,0,0]),add(center,[0,.18,0]),light,.72);
      out.triangle(add(center,[0,0,-.095]),add(center,[0,0,.095]),add(center,[0,.18,0]),light,.72);
    }
  }

  function waypoint(out, random) {
    const wood = color("#977365");
    const gray = color("#a99aae");
    const mark = color("#e9b594");
    tent(out, -2.55, -.88, "#baabbd");
    stone(out, [-.15,.05,.92], .74, .42, gray, random);
    tube(out, [-.15,.15,.93], [-.15,1.47,.93], .11, .095, 5, wood);
    const p = (x,y,z) => [-.15+x,y,.93+z];
    out.quad(p(-.56,1.22,0),p(.63,1.22,0),p(.63,1.56,0),p(-.56,1.56,0),mark);
    out.triangle(p(.63,1.22,0),p(.87,1.39,0),p(.63,1.56,0),mark);
    out.quad(p(-.30,1.37,.018),p(.36,1.37,.018),p(.36,1.405,.018),p(-.30,1.405,.018),color("#76595d"));
    const steps = [[-.83,2.93],[-1.1,2.34],[-.68,1.64],[.81,-.18],[1.58,-.92],[1.94,-1.97],[2.15,-2.82]];
    for (const [index,[x,z]] of steps.entries()) {
      stone(out,[x,.085,z],.154,.102,gray,random);
      const p = (dx,dz) => [x+dx,.191,z+dz];
      const marker = (index+1)/steps.length;
      const tint = color("#baafa5");
      out.triangle(p(-.11,0),p(0,.115),p(.11,0),tint,0,marker);
      out.triangle(p(-.11,0),p(.11,0),p(0,-.115),tint,0,marker);
    }
  }

  function flames() {
    const out = mesh();
    function tier(radius, height, bottom, shades, phase) {
      const rings = [.88,.97,.61,.35,0].map((factor,index) => Array.from({length: 8}, (_, i) => {
        const angle = tau * i / 8 + phase + index * .29;
        const width = radius * factor * (.77 + .27 * Math.cos(i * 2.3 + index));
        return [Math.cos(angle)*width + .13 * index / 4, bottom+height*index/4, Math.sin(angle)*width];
      }));
      for (let index = 0; index < 4; index += 1) {
        for (let side = 0; side < 8; side += 1) {
          const next = (side + 1) % 8;
          const tint = color(shades[(side + index) % shades.length]);
          out.quad(rings[index][side],rings[index][next],rings[index+1][next],rings[index+1][side],tint,.95);
        }
      }
    }
    tier(.44,1.70,.24,["#e96637","#f6823e","#fa995b","#f88e41"],.19);
    tier(.32,1.14,.23,["#ff9c46","#ffbc54","#ffc967","#ffe19b"],.49);
    tier(.18,.69,.25,["#ffe59e","#fff1bd","#fff8d7"],.66);
    return out;
  }

  function paperGuide() {
    const out = mesh();
    const plum = color("#a87ea4");
    const orange = color("#e98568");
    const paper = color("#fff0c9");
    const pink = color("#efb4a1");
    const hinge = [0,.05,0], tail = [.92,.21,.03], neck = [-.51,.51,.008], head = [-.79,.43,.015];
    const wingTip = [.30,.44,-.83], wingNear = [.59,.32,.92], thigh = [.46,-.19,.20], breast = [-.16,-.15,.28];
    out.triangle(hinge,neck,head,paper,.28);
    out.triangle(hinge,wingTip,tail,paper,.31);
    out.triangle(hinge,tail,wingNear,pink,.28);
    out.triangle(hinge,breast,wingNear,orange,.32);
    out.triangle(hinge,breast,thigh,plum,.18);
    out.triangle(hinge,thigh,tail,orange,.31);
    out.triangle(neck,head,[-.97,.38,.02],orange,.30);
    return out;
  }

  function terrain(variant) {
    const random = randomSource(1708);
    const out = mesh();
    floor(out, random, variant);
    const trees = [
      [-4.0,-.2,1.58],[-3.8,-1.13,2.22],[-3.14,-2.48,2.83],[-3.71,-2.0,1.84],
      [-2.24,-3.05,1.78],[-1.32,-3.48,2.53],[-.28,-3.0,1.61],[.33,-3.45,2.07],
      [1.44,-3.10,2.34],[3.00,-2.79,2.58],[3.6,-1.67,2.18],[4.28,-.86,1.73],
      [3.62,.15,1.88],[4.33,.44,1.45],[-4.03,1.04,1.27],[-3.49,1.65,1.4],
    ];
    for (const [index, [x,z,h]] of trees.entries()) tree(out, x,z,h,index);
    decoration(out, random);
    if (variant === "route") waypoint(out, random);
    else campsite(out, random);
    return out;
  }

  const meshVS = `
    attribute vec3 aPosition; attribute vec3 aNormal; attribute vec3 aTint; attribute vec2 aMaterial;
    uniform mat4 uCamera; uniform vec3 uOffset; uniform vec4 uMotion;
    varying vec3 vWorld; varying vec3 vNormal; varying vec3 vTint; varying vec2 vMaterial;
    void main(){
      vec3 p=aPosition;
      p.x+=uMotion.y*p.y; p.z+=uMotion.z*p.y; p.y*=uMotion.x;
      vWorld=p+uOffset; vNormal=aNormal; vTint=aTint; vMaterial=aMaterial;
      gl_Position=uCamera*vec4(vWorld,1.0);
    }
  `;
  const meshFS = `
    precision mediump float;
    uniform vec3 uEye; uniform vec3 uFill; uniform vec3 uLight; uniform vec3 uHaze;
    uniform float uStrength; uniform float uFire; uniform vec3 uLightOrigin; uniform vec3 uKey; uniform float uProgress;
    varying vec3 vWorld; varying vec3 vNormal; varying vec3 vTint; varying vec2 vMaterial;
    void main(){
      vec3 normal=normalize(vNormal);
      float facing=max(0.0,dot(normal,uKey));
      float strength=mix(.28,.73,clamp(uStrength*1.35,0.0,1.0));
      vec3 ambient=uFill*(strength+.19*max(0.0,normal.y));
      vec3 shaded=vTint*(ambient+uLight*facing*uStrength);
      vec3 toFire=uLightOrigin-vWorld;
      float distance2=dot(toFire,toFire);
      float flame=uFire/(.88+1.25*distance2);
      float faceFire=max(.12,dot(normal,normalize(toFire+vec3(.001))));
      shaded += vec3(1.0,.40,.12)*flame*faceFire*(.14+.86*vTint);
      shaded=mix(shaded,vTint*(.88+.13*uFire),vMaterial.x);
      // Diffuse contact shadows under the biggest props keep them grounded.
      float below=1.0-smoothstep(.01,.56,max(vWorld.y,0.0));
      float shadow=exp(-1.48*dot(vWorld.xz-vec2(-2.37,-.82),vWorld.xz-vec2(-2.37,-.82)));
      shadow+=.55*exp(-1.64*dot(vWorld.xz-vec2(1.7,-2.03),vWorld.xz-vec2(1.7,-2.03)));
      shaded*=1.0-.22*min(shadow,1.0)*below;
      float fog=smoothstep(15.5,29.0,distance(vWorld,uEye)) * .66;
      shaded=mix(shaded,uHaze,fog*.72);
      float lit=smoothstep(vMaterial.y-.10,vMaterial.y,uProgress)*step(.01,vMaterial.y);
      shaded=mix(shaded,vec3(1.,.61,.24),lit*.86);
      gl_FragColor=vec4(pow(clamp(shaded,0.0,1.0),vec3(1.0/2.2)),1.0);
    }
  `;
  const skyVS = `
    attribute vec2 aCoord; varying vec2 vUV;
    void main(){vUV=aCoord*.5+.5;gl_Position=vec4(aCoord,0.0,1.0);}
  `;
  const skyFS = `
    precision mediump float;
    varying vec2 vUV; uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uRidge;
    uniform float uMoon; uniform float uStars; uniform float uAspect; uniform float uYaw; uniform vec2 uOrb;
    float hash(vec2 p){return fract(sin(dot(p,vec2(128.7,93.1)))*43758.5453);}
    float peaks(float x){
      float k=floor(x), f=fract(x);
      float summit=.30+.34*hash(vec2(k,1.4));
      return (1.0-abs(f-.5)*2.0)*summit + mix(hash(vec2(k,.2)),hash(vec2(k+1.0,.2)),f)*.33;
    }
    void main(){
      vec2 st=vUV;
      vec3 color=mix(uHorizon,uTop,smoothstep(.13,1.0,st.y));
      vec2 orb=uOrb+vec2(uYaw*.09,0.0);
      vec2 ref=(st-orb)*vec2(uAspect,1.0);
      float d=length(ref);
      float moon=mix(.051,.043,uMoon);
      float disk=1.0-smoothstep(moon-.002,moon+.004,d);
      float cut=1.0-smoothstep(.036,.045,length(ref-vec2(.019,.010)));
      disk*=1.0-cut*uMoon*.96;
      float rim=exp(-2.9*d)*(.20-uMoon*.105);
      color=mix(color,uSun,disk*.92+rim);
      float rays=exp(-7.8*d)*(.16-uMoon*.09);
      color+=vec3(.19,.11,.06)*rays;
      vec2 grain=vec2(39.0*uAspect,39.0);
      vec2 point=st*grain;
      vec2 id=floor(point);
      float r=hash(id);
      vec2 center=vec2(hash(id+8.3),hash(id+2.7))*.60+.2;
      float star=(1.0-smoothstep(.018,.079,length(fract(point)-center))) * step(.952,r) * smoothstep(.51,.76,st.y);
      color=mix(color,vec3(.90,.91,.99),star*uStars*.86);
      vec2 cloud=(st-vec2(.27+uYaw*.13,.7))*vec2(3.0,15.2);
      float wisps=exp(-dot(cloud,cloud))*0.11;
      cloud=(st-vec2(.47+uYaw*.09,.64))*vec2(2.8,21.4);
      wisps+=exp(-dot(cloud,cloud))*.095;
      color=mix(color,uSun,wisps*(1.0-uMoon*.52));
      // Far ridgelines have their own parallax and leave sky visible above the 3D island.
      float farPeak=.377+peaks((st.x+uYaw*.051)*6.24+1.97)*.23;
      float nearPeak=.283+peaks((st.x+uYaw*.088)*5.51+2.42)*.20;
      float hazeMix=smoothstep(.02,.44,st.y);
      color=mix(color,mix(uHorizon,uRidge,hazeMix*.74),1.0-smoothstep(farPeak-.003,farPeak+.004,st.y));
      color=mix(color,mix(uHorizon,uRidge,pow(hazeMix,1.45)*.73),1.0-smoothstep(nearPeak-.002,nearPeak+.003,st.y));
      gl_FragColor=vec4(color,1.0);
    }
  `;
  const sparksVS = `
    attribute vec4 aSpark; uniform mat4 uCamera; uniform float uScale; varying float vFade;
    void main(){gl_Position=uCamera*vec4(aSpark.xyz,1.0);gl_PointSize=uScale*(1.8+4.6*aSpark.w);vFade=aSpark.w;}
  `;
  const sparksFS = `
    precision mediump float; varying float vFade;
    void main(){
      float d=length(gl_PointCoord-.5);
      float alpha=(1.0-smoothstep(.03,.49,d))*vFade*.91;
      gl_FragColor=vec4(1.0,.45+.45*vFade,.16+.45*vFade,alpha);
    }
  `;

  function program(gl, vs, fs, attributes, uniforms) {
    function shader(source, type) {
      const output = gl.createShader(type);
      gl.shaderSource(output, source);
      gl.compileShader(output);
      if (!gl.getShaderParameter(output,gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(output);
        gl.deleteShader(output);
        throw new Error(error);
      }
      return output;
    }
    const vertex = shader(vs,gl.VERTEX_SHADER);
    const fragment = shader(fs,gl.FRAGMENT_SHADER);
    const output = gl.createProgram();
    gl.attachShader(output,vertex);
    gl.attachShader(output,fragment);
    gl.linkProgram(output);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(output,gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(output);
      gl.deleteProgram(output);
      throw new Error(error);
    }
    return { program: output,
      attrs: Object.fromEntries(attributes.map((name) => [name,gl.getAttribLocation(output,name)])),
      uniforms: Object.fromEntries(uniforms.map((name) => [name,gl.getUniformLocation(output,name)])),
    };
  }

  function camera(yaw, aspect, variant) {
    const at = [0, variant === "route" ? .74 : .67, .25];
    const eye = [14.1 * Math.sin(yaw), 8.0, 14.1 * Math.cos(yaw)];
    const forward = unit(difference(eye, at));
    const right = unit(cross([0,1,0],forward));
    const up = cross(forward,right);
    const view = [right[0],up[0],forward[0],0, right[1],up[1],forward[1],0,
      right[2],up[2],forward[2],0, -dot(right,eye),-dot(up,eye),-dot(forward,eye),1];
    const h = Math.max(8.18, 10.8 / aspect);
    const x = 2 / (h * aspect), y = 2 / h, z = -2 / 36;
    const matrix = new Float32Array(view.map((v,i) => v * [x,y,z,1][i%4]));
    matrix[14] -= 1;
    return { matrix, eye };
  }

  function buildRenderer(gl, variant) {
    const meshes = program(gl, meshVS, meshFS, ["aPosition","aNormal","aTint","aMaterial"],
      ["uCamera","uOffset","uMotion","uEye","uFill","uLight","uHaze","uStrength","uFire","uLightOrigin","uKey","uProgress"]);
    const sky = program(gl,skyVS,skyFS,["aCoord"],["uTop","uHorizon","uSun","uRidge","uMoon","uStars","uAspect","uYaw","uOrb"]);
    const particles = program(gl,sparksVS,sparksFS,["aSpark"],["uCamera","uScale"]);
    const allAttributes = [meshes,sky,particles].flatMap((object) => Object.values(object.attrs)).filter((loc) => loc >= 0);
    const buffers = [];
    function load(vertices, usage = gl.STATIC_DRAW) {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),usage);
      buffers.push(buffer);
      return buffer;
    }
    const world = terrain(variant);
    const volume = variant === "route" ? paperGuide() : flames();
    const worldData = load(world.vertices), effectData = load(volume.vertices);
    const skyData = load([-1,-1,1,-1,-1,1,1,1]);
    const seeds = [];
    const random = randomSource(1983);
    for (let i = 0; i < 33; i += 1) seeds.push([random(), random(), random(), random()]);
    const specks = new Float32Array(seeds.length*4);
    const sparkData = load(specks,gl.DYNAMIC_DRAW);
    const empty = [0,0,0];
    const natural = [1,0,0,0];

    function bind(info, buffer) {
      for (const loc of allAttributes) gl.disableVertexAttribArray(loc);
      gl.useProgram(info.program);
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    }

    function attr(info, key, count, stride, offset) {
      const loc = info.attrs[key];
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc,count,gl.FLOAT,false,stride,offset);
    }

    function bindMesh(buffer) {
      bind(meshes,buffer);
      attr(meshes,"aPosition",3,44,0);
      attr(meshes,"aNormal",3,44,12);
      attr(meshes,"aTint",3,44,24);
      attr(meshes,"aMaterial",2,44,36);
    }

    function draw(width, height, yaw, time, palette, warmth, progress) {
      const aspect = width / height;
      const {matrix,eye} = camera(yaw,aspect,variant);
      const sendColor = (u, key, lin = false) => gl.uniform3fv(u["u"+key[0].toUpperCase()+key.slice(1)], lin ? palette[key].map((v) => v ** 2.2) : palette[key]);
      const pulse = .93 + .1 * Math.sin(time*7.1)+.05*Math.sin(time*12.9);
      gl.viewport(0,0,width,height);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      bind(sky,skyData);
      attr(sky,"aCoord",2,0,0);
      for (const name of ["top","horizon","sun","ridge"]) sendColor(sky.uniforms,name);
      gl.uniform1f(sky.uniforms.uMoon,palette.moon);
      gl.uniform1f(sky.uniforms.uStars,palette.stars);
      gl.uniform1f(sky.uniforms.uAspect,aspect);
      gl.uniform1f(sky.uniforms.uYaw,yaw-baseYaw);
      gl.uniform2f(sky.uniforms.uOrb,palette.sunX,palette.sunY);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);

      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      bindMesh(worldData);
      const u = meshes.uniforms;
      gl.uniformMatrix4fv(u.uCamera,false,matrix);
      gl.uniform3fv(u.uEye,eye);
      // Fill and key are irradiance colors; retain their energy in these simple matte materials.
      sendColor(u,"fill");
      sendColor(u,"light");
      sendColor(u,"haze",true);
      gl.uniform1f(u.uStrength,palette.strength);
      gl.uniform1f(u.uProgress,progress);
      gl.uniform3fv(u.uKey,unit([palette.lightX, palette.sunY + .20, .68]));
      gl.uniform1f(u.uFire,variant === "route" ? .08 : (warmth * 1.10 + .20) * pulse * (1.05 + palette.moon*.35));
      gl.uniform3fv(u.uLightOrigin,add(origin,[0,.70,0]));
      gl.uniform3fv(u.uOffset,empty);
      gl.uniform4fv(u.uMotion,natural);
      gl.drawArrays(gl.TRIANGLES,0,world.vertices.length/11);

      bindMesh(effectData);
      if (variant === "route") {
        gl.uniform3fv(u.uOffset,[1.38+.34*Math.sin(time*.8),2.18+.16*Math.sin(time*1.48),1.06]);
        gl.uniform4fv(u.uMotion,[1,.13*Math.sin(time*1.1),.07*Math.sin(time*.91),0]);
      } else {
        gl.uniform3fv(u.uOffset,origin);
        gl.uniform4fv(u.uMotion,[(.53+.47*warmth)*pulse,.13*Math.sin(time*4.8), .12*Math.cos(time*3.8),0]);
      }
      gl.drawArrays(gl.TRIANGLES,0,volume.vertices.length/11);

      for (const [i,[delay,turn,spread,rate]] of seeds.entries()) {
        const life = (delay + time * (.19 + rate*.27)) % 1;
        const phase = turn * tau + time*.44;
        const distance = variant === "route" ? .65 + life * 2.25 : (.20+life*.75) * spread;
        const x = origin[0] + Math.cos(phase) * distance;
        const y = .42 + life * (variant === "route" ? 2.2 : 2.75);
        const z = origin[2] + Math.sin(phase) * distance;
        const fade = Math.sin(life * Math.PI) * (.12 + .60 * rate) * (variant === "route" ? .24+palette.stars*.33 : .33+warmth*.66);
        specks.set([x,y,z,fade], i*4);
      }
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
      bind(particles,sparkData);
      attr(particles,"aSpark",4,0,0);
      gl.bufferSubData(gl.ARRAY_BUFFER,0,specks);
      gl.uniformMatrix4fv(particles.uniforms.uCamera,false,matrix);
      gl.uniform1f(particles.uniforms.uScale,Math.min(2,height/255));
      gl.drawArrays(gl.POINTS,0,seeds.length);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    function destroy() {
      for (const buffer of buffers) gl.deleteBuffer(buffer);
      for (const pass of [meshes,sky,particles]) gl.deleteProgram(pass.program);
    }

    return { draw, destroy };
  }

  function paletteFor(theme) {
    const base = themes[theme] || themes.day;
    return Object.fromEntries(Object.entries(base).map(([key, value]) =>
      [key, typeof value === "string" ? numbers(value) : value]));
  }

  function attach(canvas, {theme = "day", lit = true, variant = "camp"} = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    let gl;
    let renderer;
    const reduced = window.QuizWorldMotion?.preference || matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false, visible = false, renderable = true, scheduled = 0, last = 0, elapsed = 0;
    const next = () => {
      if (!scheduled && !disposed && renderable && visible && !document.hidden) {
        scheduled = requestAnimationFrame(frame);
      }
    };
    let activeTheme = Object.hasOwn(themes, theme) ? theme : "day";
    let current = paletteFor(activeTheme), target = current, mixing = 0;
    let yaw = baseYaw, desired = baseYaw;
    let flame = lit ? 1 : 0, desiredFlame = flame;
    let progress = 0, desiredProgress = 0;
    let pointer = null;

    function setRendered(value) {
      if (value) {
        canvas.dataset.sceneRendered = "true";
        canvas.dataset.worldRendered = "true";
      } else {
        delete canvas.dataset.sceneRendered;
        delete canvas.dataset.worldRendered;
      }
    }

    function initialize() {
      try {
        gl ??= canvas.getContext("webgl", {
          alpha:false, antialias:true, depth:true, stencil:false,
          preserveDrawingBuffer:false, powerPreference:"low-power",
        });
        if (gl) renderer = buildRenderer(gl,variant);
      } catch {
        renderer = null;
      }
      renderable = Boolean(renderer);
      return renderable;
    }

    function frame(now) {
      scheduled = 0;
      if (disposed || !renderable || !visible || document.hidden) return;
      if (last && now - last < 31 && !reduced.matches) {
        next();
        return;
      }
      const width = canvas.clientWidth, height = canvas.clientHeight;
      if (width < 1 || height < 1 || (!renderer && !initialize())) return;
      const delta = last ? Math.min(.066, (now-last)/1000) : 1/30;
      last = now;
      const ratio = Math.min(devicePixelRatio || 1,1.75,Math.sqrt(445000/(width*height)));
      const px = Math.max(1,Math.round(width*ratio)), py = Math.max(1,Math.round(height*ratio));
      if (canvas.width !== px || canvas.height !== py) {
        canvas.width = px;
        canvas.height = py;
      }
      const relax = reduced.matches ? 1 : 1-Math.exp(-delta*9.0);
      if (target !== current) {
        mixing += delta;
        if (reduced.matches || mixing > .58) current = target;
        else {
          current = Object.fromEntries(Object.keys(target).map((key) => [
            key, Array.isArray(target[key]) ? mix(current[key],target[key],relax) : lerp(current[key],target[key],relax),
          ]));
        }
      }
      yaw = lerp(yaw,desired,relax);
      flame = lerp(flame,desiredFlame,relax);
      progress = lerp(progress,desiredProgress,relax);
      if (!reduced.matches) elapsed += delta;
      renderer.draw(px,py,yaw,elapsed,current,flame,progress);
      if (canvas.dataset.worldRendered !== "true") setRendered(true);
      if (!reduced.matches) next();
    }

    function rotate(direction) {
      desired = Math.max(baseYaw-.67,Math.min(baseYaw+.67,desired + direction*.23));
      next();
    }

    function down(event) {
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      pointer = { id:event.pointerId, x:event.clientX, y:event.clientY, angle:desired, dragging:false };
    }
    function move(event) {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX-pointer.x, dy = event.clientY-pointer.y;
      if (!pointer.dragging) {
        if (Math.abs(dy) > 7 && Math.abs(dy) > Math.abs(dx)) { pointer = null; return; }
        if (Math.abs(dx) < 7) return;
        pointer.dragging = true;
        canvas.setPointerCapture(event.pointerId);
      }
      desired = Math.max(baseYaw-.67, Math.min(baseYaw+.67,pointer.angle-dx*.0060));
      next();
    }
    function up(event) {
      if (pointer?.id !== event.pointerId) return;
      pointer = null;
    }
    function lost(event) {
      event.preventDefault();
      renderer = null;
      renderable = false;
      setRendered(false);
    }
    function restored() {
      renderable = true;
      last = 0;
      next();
    }
    function visibilityChanged() {
      last = 0;
      next();
    }
    const events = [
      [canvas,"pointerdown",down], [canvas,"pointermove",move], [canvas,"pointerup",up],
      [canvas,"pointercancel",up], [canvas,"lostpointercapture",up], [canvas,"webglcontextlost",lost],
      [canvas,"webglcontextrestored",restored], [document,"visibilitychange",visibilityChanged], [reduced,"change",next],
    ];
    for (const [targetEvent,type,listener] of events) targetEvent.addEventListener(type,listener);
    const resize = new ResizeObserver(next);
    resize.observe(canvas);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      last = 0;
      if (visible) next();
    }, {rootMargin:"28px"});
    observer.observe(canvas);
    return {
      setTheme(mode) {
        const name = Object.hasOwn(themes, mode) ? mode : "day";
        if (activeTheme === name) return;
        activeTheme = name;
        target = paletteFor(name);
        mixing = 0;
        next();
      },
      setLit(isLit) { desiredFlame = isLit ? 1 : 0; next(); },
      setProgress(ratio) {
        desiredProgress = Number.isFinite(ratio) ? Math.max(0,Math.min(1,ratio)) : 0;
        next();
      },
      rotate,
      resetView() { desired = baseYaw; next(); },
      destroy() {
        disposed = true;
        cancelAnimationFrame(scheduled);
        resize.disconnect();
        observer.disconnect();
        for (const [targetEvent,type,listener] of events) targetEvent.removeEventListener(type,listener);
        renderer?.destroy();
        setRendered(false);
      },
    };
  }

  window.QuizCampScene = { attach };
})();
