import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from ai_game import AITriangularGame

if __name__ == '__main__':
    game = AITriangularGame()
    game.run()
