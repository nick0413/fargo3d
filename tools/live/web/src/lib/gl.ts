// WebGL2 field renderer. One full-screen triangle, one fragment shader doing:
//   screen -> model -> (r, phi) -> field texture with manual bilinear -> transfer -> LUT colour
// texelFetch with a hand-written bilinear tap avoids needing OES_texture_float_linear, so this
// works on any WebGL2 implementation including software rasterisers.

import { Frame, Range, cmap, RMIN, RMAX } from './fargo'

const EXT = 2.62

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`

const FS = `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform sampler2D uLut;
uniform vec2  uSize;
uniform vec2  uRange;
uniform int   uScale;
uniform float uTheta;
uniform float uExt;
uniform float uRmin;
uniform float uRmax;
in  vec2 vUv;
out vec4 fragColor;
const float PI = 3.141592653589793;

float fieldAt(vec2 uv) {
  vec2 p = uv * uSize - 0.5;
  vec2 i0 = floor(p);
  vec2 f  = p - i0;
  float x0 = mod(i0.x, uSize.x), x1 = mod(i0.x + 1.0, uSize.x);
  float y0 = clamp(i0.y, 0.0, uSize.y - 1.0);
  float y1 = clamp(i0.y + 1.0, 0.0, uSize.y - 1.0);
  float v00 = texelFetch(uField, ivec2(int(x0), int(y0)), 0).r;
  float v10 = texelFetch(uField, ivec2(int(x1), int(y0)), 0).r;
  float v01 = texelFetch(uField, ivec2(int(x0), int(y1)), 0).r;
  float v11 = texelFetch(uField, ivec2(int(x1), int(y1)), 0).r;
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * uExt;
  float r = length(p);
  if (r < uRmin || r > uRmax) discard;

  float phi = atan(p.y, p.x) - uTheta;
  phi = mod(phi + PI, 2.0 * PI) - PI;
  vec2 uv = vec2((phi + PI) / (2.0 * PI), (r - uRmin) / (uRmax - uRmin));

  float v = fieldAt(uv);
  float tf = (uScale == 0) ? log(max(v, 1e-30)) / log(10.0) : v;
  float t = clamp((tf - uRange.x) / max(uRange.y - uRange.x, 1e-12), 0.0, 1.0);
  fragColor = texture(uLut, vec2(t, 0.5));
}`

export type GLOpts = { frame: 'rot' | 'inertial'; scale: 'log' | 'linear' }

export type GLRenderer = { draw: (f: Frame, o: GLOpts, range: Range, field: number) => void }

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s))
  }
  return s
}

export function createGL(canvas: HTMLCanvasElement): GLRenderer | null {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false })
  if (!gl) return null

  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog))
  gl.useProgram(prog)

  // full-screen triangle
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  // colour lookup table, 256 x 1 RGBA8
  const lut = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const c = cmap(i / 255)
    lut[i * 4] = c[0]; lut[i * 4 + 1] = c[1]; lut[i * 4 + 2] = c[2]; lut[i * 4 + 3] = 255
  }
  const lutTex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, lutTex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const fieldTex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, fieldTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const u = (n: string) => gl.getUniformLocation(prog, n)
  const U = {
    field: u('uField'), lut: u('uLut'), size: u('uSize'), range: u('uRange'),
    scale: u('uScale'), theta: u('uTheta'), ext: u('uExt'), rmin: u('uRmin'), rmax: u('uRmax'),
  }
  gl.uniform1i(U.field, 0)
  gl.uniform1i(U.lut, 1)
  gl.uniform1f(U.ext, EXT)
  gl.uniform1f(U.rmin, RMIN)
  gl.uniform1f(U.rmax, RMAX)

  const size = { nx: 0, ny: 0 }

  return {
    draw(f: Frame, o: GLOpts, range: Range, fieldIdx: number) {
      const data = f.fields[Math.min(fieldIdx, f.nfields - 1)]
      if (!data) return
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, fieldTex)
      if (size.nx !== f.nx || size.ny !== f.ny) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, f.nx, f.ny, 0, gl.RED, gl.FLOAT, data)
        size.nx = f.nx; size.ny = f.ny
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.nx, f.ny, gl.RED, gl.FLOAT, data)
      }
      gl.uniform2f(U.size, f.nx, f.ny)
      gl.uniform2f(U.range, range.lo, range.hi)
      gl.uniform1i(U.scale, o.scale === 'log' ? 0 : 1)
      gl.uniform1f(U.theta, o.frame === 'inertial' ? f.theta : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
  }
}
