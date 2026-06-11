import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core algorithm'))
from ai_game import AITriangularGame

if __name__ == '__main__':
    game = AITriangularGame()
    game.run()
