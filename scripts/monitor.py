#!/usr/bin/env python3
"""
Monitor de peticiones de red en tiempo real
Muestra una gráfica en terminal del tráfico saliente del puerto 3333
"""

import psutil
import time
from collections import deque
import os
import sys

class NetworkMonitor:
    def __init__(self, port=3333, max_points=50):
        self.port = port
        self.max_points = max_points
        self.data = deque([0] * max_points, maxlen=max_points)
        self.max_value = 10
        
    def get_connections_count(self):
        """Cuenta las conexiones activas desde el puerto especificado"""
        count = 0
        try:
            connections = psutil.net_connections(kind='inet')
            for conn in connections:
                # Verifica si la conexión local es desde nuestro puerto
                if conn.laddr.port == self.port and conn.status == 'ESTABLISHED':
                    count += 1
        except (psutil.AccessDenied, PermissionError):
            print("\n⚠️  Se requieren permisos de administrador/root")
            print("Ejecuta con: sudo python3 script.py")
            sys.exit(1)
        return count
    
    def draw_chart(self):
        """Dibuja la gráfica en el terminal"""
        os.system('clear' if os.name != 'nt' else 'cls')
        
        print("=" * 60)
        print(f"  Monitor de Peticiones - Puerto {self.port}")
        print("=" * 60)
        print()
        
        # Ajusta el valor máximo dinámicamente
        current_max = max(self.data) if max(self.data) > 0 else 10
        self.max_value = max(self.max_value * 0.9, current_max * 1.2)
        
        # Altura de la gráfica
        height = 15
        
        # Dibuja la gráfica
        for row in range(height, -1, -1):
            threshold = (row / height) * self.max_value
            line = f"{int(threshold):3d} |"
            
            for value in self.data:
                if value >= threshold:
                    line += "█"
                elif value >= threshold - (self.max_value / height / 2):
                    line += "▄"
                else:
                    line += " "
            
            print(line)
        
        # Línea base
        print("    +" + "-" * self.max_points)
        
        # Estadísticas
        current = self.data[-1]
        avg = sum(self.data) / len(self.data)
        max_val = max(self.data)
        
        print()
        print(f"  🟢 Peticiones actuales: {current}")
        print(f"  📊 Promedio: {avg:.1f}")
        print(f"  📈 Máximo: {int(max_val)}")
        print()
        print("  Presiona Ctrl+C para detener")
        
    def run(self, interval=1):
        """Ejecuta el monitor"""
        print(f"Iniciando monitor en puerto {self.port}...")
        print("Obteniendo permisos...")
        
        try:
            while True:
                count = self.get_connections_count()
                self.data.append(count)
                self.draw_chart()
                time.sleep(interval)
                
        except KeyboardInterrupt:
            print("\n\n✓ Monitor detenido")
            sys.exit(0)

if __name__ == "__main__":
    # Verifica argumentos
    port = 3333
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("Puerto inválido. Uso: python3 script.py [puerto]")
            sys.exit(1)
    
    monitor = NetworkMonitor(port=port)
    monitor.run(interval=1)