import { useEffect, useRef } from 'react';

interface WebGLBackgroundProps {
    enabled: boolean;
}

export function WebGLBackground({ enabled }: WebGLBackgroundProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!enabled || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const gl = canvas.getContext('webgl');
        if (!gl) return;

        let animationFrameId: number;

        const vsSource = `
      attribute vec4 aVertexPosition;
      void main() {
        gl_Position = aVertexPosition;
      }
    `;

        // A subtle moving noise grain + vignette
        const fsSource = `
      precision lowp float;
      uniform float uTime;
      uniform vec2 uResolution;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / uResolution.xy;
        float noise = hash(uv * uTime);
        
        // Vignette
        vec2 center = uv - 0.5;
        float dist = length(center);
        float vignette = smoothstep(0.8, 0.2, dist);
        
        // Very subtle noise intensity setup for dark theme
        float intensity = noise * 0.03 * vignette;
        gl_FragColor = vec4(vec3(intensity), 1.0);
      }
    `;

        const loadShader = (type: number, source: string) => {
            const shader = gl.createShader(type);
            if (!shader) return null;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        };

        const vertexShader = loadShader(gl.VERTEX_SHADER, vsSource);
        const fragmentShader = loadShader(gl.FRAGMENT_SHADER, fsSource);
        if (!vertexShader || !fragmentShader) return;

        const shaderProgram = gl.createProgram();
        if (!shaderProgram) return;

        gl.attachShader(shaderProgram, vertexShader);
        gl.attachShader(shaderProgram, fragmentShader);
        gl.linkProgram(shaderProgram);

        if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) return;

        gl.useProgram(shaderProgram);

        const positions = new Float32Array([
            -1.0, 1.0,
            1.0, 1.0,
            -1.0, -1.0,
            1.0, -1.0,
        ]);

        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        const vertexPositionAttr = gl.getAttribLocation(shaderProgram, 'aVertexPosition');
        gl.enableVertexAttribArray(vertexPositionAttr);
        gl.vertexAttribPointer(vertexPositionAttr, 2, gl.FLOAT, false, 0, 0);

        const timeUniformLocation = gl.getUniformLocation(shaderProgram, 'uTime');
        const resolutionUniformLocation = gl.getUniformLocation(shaderProgram, 'uResolution');

        const render = (time: number) => {
            // Respect reduced motion internally if we want, but better to check in CSS or settings
            const matchMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
            if (matchMedia.matches) {
                // If reduced motion, stop animating uTime, keep it static
                time = 1000.0;
            }

            // Resize canvas exactly to screen dims
            if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;
                gl.viewport(0, 0, canvas.width, canvas.height);
            }

            gl.clearColor(0.0, 0.0, 0.0, 1.0); // We only add noise over black, though container handles background
            gl.clear(gl.COLOR_BUFFER_BIT);

            gl.uniform1f(timeUniformLocation, (time * 0.0001) % 1000.0);
            gl.uniform2f(resolutionUniformLocation, canvas.width, canvas.height);

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            animationFrameId = requestAnimationFrame(render);
        };

        animationFrameId = requestAnimationFrame(render);

        return () => {
            cancelAnimationFrame(animationFrameId);
        };
    }, [enabled]);

    if (!enabled) return null;

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100vw',
                height: '100vh',
                pointerEvents: 'none',
                zIndex: 0, // Behind app shell
                opacity: 0.6 // Subtle
            }}
        />
    );
}
