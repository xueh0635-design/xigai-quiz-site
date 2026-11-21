/*
 * Adapted from TiHxdvt/liquid-glass-webgl, revision cef68d6b18b53e4b355b8e4dad69f240fc2a8371.
 * https://github.com/TiHxdvt/liquid-glass-webgl/blob/cef68d6b18b53e4b355b8e4dad69f240fc2a8371/liquid-glass-webgl.js
 *
 * MIT License
 * Copyright (c) 2026 HaodongWen
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

(() => {
  "use strict";

  const vertexSource = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const fragmentSource = `#version 300 es
precision highp float;
uniform vec2 uPixels;
uniform vec2 uSize;
uniform float uFlow;
uniform float uEnergy;
out vec4 outColor;

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

float glassDistance(vec2 point, vec2 bounds) {
  float deformation = abs(uFlow);
  if (deformation < 0.002) {
    return sdRoundRect(point, bounds, min(bounds.x, bounds.y));
  }

  // A pair of unequal circular caps joined by their common external tangents.
  float head = min(bounds.y, bounds.x * 0.98);
  float tail = head * mix(1.0, 0.34, deformation);
  float span = 2.0 * bounds.x - head - tail;
  float along = point.x * sign(uFlow) + bounds.x - tail;
  float across = abs(point.y);
  float sine = (head - tail) / span;
  float cosine = sqrt(1.0 - sine * sine);
  float projection = along * cosine + across * sine;
  if (projection < 0.0) return length(vec2(along, across)) - tail;
  if (projection > cosine * span) return length(vec2(along - span, across)) - head;
  return across * cosine - along * sine - tail;
}

float schlick(float viewCosine) {
  const float R0 = 0.04;
  return R0 + (1.0 - R0) * pow(1.0 - viewCosine, 5.0);
}

vec2 transmittedRay(vec3 normal, float wavelength) {
  // Cauchy refractive index, with wavelengths expressed in micrometres.
  float ior = 1.5046 + 0.0042 / (wavelength * wavelength);
  return refract(vec3(0.0, 0.0, -1.0), normal, 1.0 / ior).xy;
}

float studioLight(vec2 samplePoint, vec2 bounds) {
  // Analytic studio lights form a narrow dark gap between two diffuse strips.
  // Sampling them at three refracted positions separates their wavelengths.
  float depth = -glassDistance(samplePoint, bounds);
  float light = (depth - 6.6) / 2.35;
  float gap = (depth - 9.25) / 0.92;
  float fill = smoothstep(-0.82, 0.92, samplePoint.y / bounds.y);
  return 0.46 + 0.20 * fill + 0.28 * exp(-light * light) - 0.43 * exp(-gap * gap);
}

void main() {
  vec2 bounds = max(uSize * 0.5 - 1.25, vec2(1.0));
  vec2 point = (gl_FragCoord.xy / uPixels - 0.5) * uSize;
  float distance = glassDistance(point, bounds);
  float aa = max(fwidth(distance), 0.5);
  float coverage = 1.0 - smoothstep(-aa * 0.55, aa * 0.55, distance);
  if (coverage <= 0.0) {
    outColor = vec4(0.0);
    return;
  }

  const float delta = 0.55;
  vec2 dx = vec2(delta, 0.0);
  vec2 dy = vec2(0.0, delta);
  vec2 outward = normalize(vec2(
    glassDistance(point + dx, bounds) - glassDistance(point - dx, bounds),
    glassDistance(point + dy, bounds) - glassDistance(point - dy, bounds)
  ) + vec2(0.00001));
  float depth = max(0.0, -distance);
  float lip = 1.0 - smoothstep(0.0, 8.5, depth);
  float rim = exp(-depth / 1.25);
  vec3 normal = normalize(vec3(outward * lip * 2.7, 1.0));
  vec2 greenRay = transmittedRay(normal, 0.546);
  vec2 greenPoint = point + greenRay * 15.5;
  float green = studioLight(greenPoint, bounds);
  float activity = max(abs(uFlow), uEnergy * 0.48);
  // A longer optical path for the wavelength difference keeps it visible at tab size.
  float dispersion = (1.0 + 8.5 * activity) * 15.5;
  float red = studioLight(greenPoint + (transmittedRay(normal, 0.656) - greenRay) * dispersion, bounds);
  float blue = studioLight(greenPoint + (transmittedRay(normal, 0.436) - greenRay) * dispersion, bounds);
  vec3 split = vec3(red - green, 0.0, blue - green);

  float facing = 0.5 + 0.5 * dot(outward, normalize(vec2(-0.55, 0.84)));
  float reflection = schlick(normal.z) * (0.38 + 0.62 * facing);
  // Map spectral separation to violet and cyan light around the current bevel.
  float separation = smoothstep(0.018, 0.22, length(split.rb));
  float angle = dot(outward, normalize(vec2(0.8 * uFlow, 0.6)));
  float hue = smoothstep(-0.21, 0.24, blue - red + angle * 0.19);
  vec3 spectrum = mix(vec3(0.65, 0.35, 0.98), vec3(0.34, 0.90, 0.96), hue);
  float edgeFade = 1.0 - smoothstep(1.1, 4.4, depth);
  float chromaAlpha = activity * separation * edgeFade * 0.72;
  float clearAlpha = 0.018 + rim * (0.27 + facing * 0.34 + uEnergy * 0.15) + reflection * 0.48;
  vec3 neutral = vec3(mix(0.55, 1.0, facing));
  vec3 color = mix(neutral, spectrum, chromaAlpha / (clearAlpha + chromaAlpha));
  float alpha = coverage * min(0.94, clearAlpha + chromaAlpha);
  outColor = vec4(clamp(color, 0.0, 1.0) * alpha, alpha);
}`;

  function makeProgram(gl) {
    const program = gl.createProgram();
    if (!program) return null;
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = gl.createShader(type);
      if (!shader) {
        gl.deleteProgram(program);
        return null;
      }
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        gl.deleteProgram(program);
        return null;
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
    gl.deleteProgram(program);
    return null;
  }

  function attach(canvas) {
    if (!canvas?.parentElement) return null;
    const parent = canvas.parentElement;
    let gl;
    try {
      // The lens stops drawing when settled, so keep its single small buffer visible.
      gl = canvas.getContext("webgl2", {
        alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true,
      });
    } catch {
      return null;
    }
    if (!gl) return null;

    const uniforms = {};
    let width = 0;
    let height = 0;
    let flow = 0;
    let energy = 0;
    let ready = false;

    function render() {
      if (!ready || !width || !height) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uPixels, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uSize, width, height);
      gl.uniform1f(uniforms.uFlow, flow);
      gl.uniform1f(uniforms.uEnergy, energy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function resize() {
      const nextWidth = canvas.clientWidth;
      const nextHeight = canvas.clientHeight;
      const scale = Math.min(window.devicePixelRatio || 1, 1.75);
      const pixelsWide = Math.max(1, Math.round(nextWidth * scale));
      const pixelsHigh = Math.max(1, Math.round(nextHeight * scale));
      if (width === nextWidth && height === nextHeight && canvas.width === pixelsWide && canvas.height === pixelsHigh) return;
      width = nextWidth;
      height = nextHeight;
      if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
      if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
      render();
    }

    function initialize() {
      const program = makeProgram(gl);
      if (!program) return false;
      gl.useProgram(program);
      for (const name of ["uPixels", "uSize", "uFlow", "uEnergy"]) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      ready = true;
      parent.dataset.optics = "webgl2";
      return true;
    }

    if (!initialize()) return null;
    resize();
    if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(canvas);
    window.addEventListener("resize", resize);
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      ready = false;
      delete parent.dataset.optics;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      if (initialize()) render();
    });

    return {
      draw(nextFlow, nextEnergy) {
        nextFlow = Math.max(-1, Math.min(1, Number.isFinite(nextFlow) ? nextFlow : 0));
        nextEnergy = Math.max(0, Math.min(1, Number.isFinite(nextEnergy) ? nextEnergy : 0));
        if (nextFlow === flow && nextEnergy === energy) return;
        flow = nextFlow;
        energy = nextEnergy;
        render();
      },
    };
  }

  window.QuizGlassOptics = { attach };
})();
