import sys, os
import pygame
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core algorithm'))
from triangular_game import TriangularGame, Player, PointState
from ai_engine import MinimaxAI
from collections import deque
import threading
from typing import Optional, List, Tuple


class AITriangularGame(TriangularGame):
    def __init__(self):
        super().__init__()
        self.ai_mode = 'human'
        self.ai_player = None
        self.ai = None
        self.ai_thinking = False
        self.ai_move_result = None
        self.ai_candidates = []
        self._ai_candidate_show_until = 0
        self._ai_depth = 3
        self.hint_pos = None
        self.hint_text = ""
        self.hint_show_until = 0
        self.hint_thinking = False
        self._hint_result = None
        self._hint_ai = MinimaxAI(2)
        self._hint_button_rect = pygame.Rect(510, 540, 130, 40)
        font_path = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "msyh.ttc")
        if not os.path.exists(font_path):
            font_path = pygame.font.match_font("Microsoft YaHei,SimHei")
        self._font_sm = pygame.font.Font(font_path, 20)
        self._font_md = pygame.font.Font(font_path, 24)
        self._font_lg = pygame.font.Font(font_path, 30)
        self._font_xl = pygame.font.Font(font_path, 50)

    def _fast_territory_bfs(self, player: Player) -> int:
        if player == Player.BLACK:
            my_states = {PointState.BLACK_NODE, PointState.BLACK_LINE}
            opp_states = {PointState.WHITE_NODE, PointState.WHITE_LINE}
        else:
            my_states = {PointState.WHITE_NODE, PointState.WHITE_LINE}
            opp_states = {PointState.BLACK_NODE, PointState.BLACK_LINE}

        frontier = deque(
            pos for pos, state in self.grid.items() if state in my_states
        )
        visited = set(frontier)

        while frontier:
            pos = frontier.popleft()
            for adjacent in self._get_adjacent_positions(pos):
                if adjacent not in visited and self.grid[adjacent] not in opp_states:
                    visited.add(adjacent)
                    frontier.append(adjacent)

        return len(visited)

    def evaluate(self, player: Player) -> float:
        opponent = Player.WHITE if player == Player.BLACK else Player.BLACK
        my_nodes = self._get_player_nodes(player)
        opp_nodes = self._get_player_nodes(opponent)
        my_lines = self._get_player_lines(player)
        opp_lines = self._get_player_lines(opponent)

        node_advantage = len(my_nodes) - len(opp_nodes)
        coverage_advantage = (
            len(my_nodes + my_lines) - len(opp_nodes + opp_lines)
        )
        territory_advantage = (
            self._fast_territory_bfs(player)
            - self._fast_territory_bfs(opponent)
        )
        attack_threats = sum(
            self._is_legal_move(point, player) for point in opp_lines
        )
        connection_quality = sum(
            1 if self._is_connected_to_initial(node, player) else -1
            for node in my_nodes
        )

        return (
            15 * node_advantage
            + 8 * coverage_advantage
            + 20 * territory_advantage
            + 12 * attack_threats
            + 10 * connection_quality
        )

    def _save_state(self) -> dict:
        return {
            'grid': dict(self.grid),
            'black_edges': {frozenset(e) for e in self.black_edges},
            'white_edges': {frozenset(e) for e in self.white_edges},
            'history_hashes': set(self.history_hashes),
            'consecutive_skips': self.consecutive_skips,
            'current_player': self.current_player,
        }

    def _restore_state(self, snapshot: dict) -> None:
        self.grid = snapshot['grid']
        self.black_edges = snapshot['black_edges']
        self.white_edges = snapshot['white_edges']
        self.history_hashes = snapshot['history_hashes']
        self.consecutive_skips = snapshot['consecutive_skips']
        self.current_player = snapshot['current_player']

    def _apply_move_for_ai(self, pos: tuple) -> bool:
        tmp_grid = dict(self.grid)
        tmp_be = {frozenset(e) for e in self.black_edges}
        tmp_we = {frozenset(e) for e in self.white_edges}

        if not self._add_node(pos):
            return False

        next_p = (
            Player.WHITE if self.current_player == Player.BLACK else Player.BLACK
        )
        h = self._compute_state_hash(next_p)
        if h in self.history_hashes:
            self.grid = tmp_grid
            self.black_edges = tmp_be
            self.white_edges = tmp_we
            return False

        self.history_hashes.add(h)
        self.consecutive_skips = 0
        self._switch_player()
        return True

    def _ai_compute_move(self) -> None:
        top = self.ai.get_top_moves(self, self.ai_player, top_n=5)
        self.ai_candidates = top
        self.ai_move_result = top[0][0] if top else 'skip'

    def _get_hint_reason(self, pos: tuple, player: Player) -> str:
        opp_line = PointState.WHITE_LINE if player == Player.BLACK else PointState.BLACK_LINE
        own_line = PointState.BLACK_LINE if player == Player.BLACK else PointState.WHITE_LINE
        if self.grid[pos] == opp_line:
            return "可截断对手连线"
        adj = self._get_adjacent_positions(pos)
        if any(self.grid[a] == opp_line for a in adj):
            return "威胁对手连线"
        if any(self.grid[a] == own_line for a in adj):
            return "扩展己方领土"
        return "抢占战略要点"

    def _compute_hint(self) -> None:
        player = self.current_player
        top = self._hint_ai.get_top_moves(self, player, top_n=1)
        if top:
            pos, _ = top[0]
            reason = self._get_hint_reason(pos, player)
            self._hint_result = (pos, reason)
        else:
            self._hint_result = ('skip', "建议跳过本回合")

    def show_mode_selection(self) -> None:
        mode_buttons = [
            (pygame.Rect(210, 175 + index * 65, 380, 48), mode, label)
            for index, (mode, label) in enumerate(
                [
                    ('human', "[1] 人人对战"),
                    ('ai_white', "[2] 人类(蓝) vs AI(红)"),
                    ('ai_black', "[3] AI(蓝) vs 人类(红)"),
                ]
            )
        ]
        difficulty_buttons = [
            (pygame.Rect(190 + index * 150, 400, 120, 48), depth, label)
            for index, (depth, label) in enumerate(
                [(2, "[E] 简单"), (3, "[M] 中等"), (4, "[H] 困难")]
            )
        ]
        start_button = pygame.Rect(290, 490, 220, 54)
        selecting = True
        while selecting:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    pygame.quit()
                    sys.exit()
                if event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_1:
                        self.ai_mode = 'human'
                    elif event.key == pygame.K_2:
                        self.ai_mode = 'ai_white'
                    elif event.key == pygame.K_3:
                        self.ai_mode = 'ai_black'
                    elif event.key == pygame.K_e:
                        self._ai_depth = 2
                    elif event.key == pygame.K_m:
                        self._ai_depth = 3
                    elif event.key == pygame.K_h:
                        self._ai_depth = 4
                    elif event.key in (pygame.K_RETURN, pygame.K_SPACE):
                        selecting = False
                elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                    for rect, mode, _ in mode_buttons:
                        if rect.collidepoint(event.pos):
                            self.ai_mode = mode
                    for rect, depth, _ in difficulty_buttons:
                        if rect.collidepoint(event.pos):
                            self._ai_depth = depth
                    if start_button.collidepoint(event.pos):
                        selecting = False

            self.screen.fill(self.WHITE)

            title = self._font_xl.render("Line Game - AI 对战模式", True, self.BLACK)
            self.screen.blit(
                title,
                title.get_rect(center=(self.SCREEN_WIDTH // 2, 80)),
            )

            for rect, mode, label in mode_buttons:
                selected = mode == self.ai_mode
                pygame.draw.rect(
                    self.screen, (220, 235, 255) if selected else (245, 245, 245),
                    rect, border_radius=8,
                )
                pygame.draw.rect(
                    self.screen, (0, 100, 255) if selected else self.GRAY,
                    rect, 3 if selected else 1, border_radius=8,
                )
                surface = self._font_lg.render(label, True, self.BLACK)
                self.screen.blit(surface, surface.get_rect(center=rect.center))

            for rect, depth, label in difficulty_buttons:
                selected = depth == self._ai_depth
                pygame.draw.rect(
                    self.screen, (220, 235, 255) if selected else (245, 245, 245),
                    rect, border_radius=8,
                )
                pygame.draw.rect(
                    self.screen, (0, 100, 255) if selected else self.GRAY,
                    rect, 3 if selected else 1, border_radius=8,
                )
                surface = self._font_md.render(label, True, self.BLACK)
                self.screen.blit(surface, surface.get_rect(center=rect.center))

            pygame.draw.rect(self.screen, (0, 110, 220), start_button, border_radius=8)
            start = self._font_lg.render("开始游戏", True, self.WHITE)
            self.screen.blit(start, start.get_rect(center=start_button.center))

            pygame.display.flip()
            self.clock.tick(60)

        if self.ai_mode == 'ai_white':
            self.ai_player = Player.WHITE
            self.ai = MinimaxAI(self._ai_depth)
        elif self.ai_mode == 'ai_black':
            self.ai_player = Player.BLACK
            self.ai = MinimaxAI(self._ai_depth)

    def draw(self) -> None:
        # Suppress the flip inside super().draw() so all layers composite in one flip
        import pygame.display as _disp
        _orig_flip = _disp.flip
        _disp.flip = lambda: None
        super().draw()
        _disp.flip = _orig_flip

        if self.ai_thinking:
            frame = (pygame.time.get_ticks() // 400) % 4
            dots = ("", ".", "..", "...")[frame]
            surface = self._font_md.render(f"AI 思考中{dots}", True, (100, 100, 100))
            self.screen.blit(surface, surface.get_rect(midtop=(self.SCREEN_WIDTH // 2, 10)))

        if pygame.time.get_ticks() < self._ai_candidate_show_until:
            overlay = pygame.Surface((self.SCREEN_WIDTH, self.SCREEN_HEIGHT), pygame.SRCALPHA)
            for index, (pos, score) in enumerate(self.ai_candidates):
                if index == 0:
                    color, radius = (255, 215, 0, 180), 14
                elif index <= 2:
                    color, radius = (255, 140, 0, 150), 11
                elif index <= 4:
                    color, radius = (150, 150, 150, 120), 9
                else:
                    continue
                screen_pos = self._get_screen_pos(*pos)
                pygame.draw.circle(overlay, color, screen_pos, radius)
                if index == 0:
                    star = self._font_sm.render("★", True, self.BLACK)
                    overlay.blit(star, star.get_rect(center=screen_pos))
            self.screen.blit(overlay, (0, 0))

        hint_available = (
            not self.game_over
            and not self.hint_thinking
            and not self.ai_thinking
            and (self.ai_player is None or self.current_player != self.ai_player)
        )
        btn_color = (60, 160, 60) if hint_available else (160, 160, 160)
        pygame.draw.rect(self.screen, btn_color, self._hint_button_rect, border_radius=6)
        pygame.draw.rect(self.screen, self.BLACK, self._hint_button_rect, 2, border_radius=6)
        btn_label = self._font_md.render("[H] 提示", True, self.WHITE)
        self.screen.blit(btn_label, btn_label.get_rect(center=self._hint_button_rect.center))

        if self.hint_thinking:
            frame = (pygame.time.get_ticks() // 300) % 4
            dots = ("", ".", "..", "...")[frame]
            surf = self._font_md.render(f"提示计算中{dots}", True, (60, 140, 60))
            self.screen.blit(surf, surf.get_rect(midtop=(self.SCREEN_WIDTH // 2, 42)))

        if pygame.time.get_ticks() < self.hint_show_until:
            if self.hint_pos is not None:
                hint_overlay = pygame.Surface((self.SCREEN_WIDTH, self.SCREEN_HEIGHT), pygame.SRCALPHA)
                pulse = abs((pygame.time.get_ticks() % 800) - 400) / 400
                radius = int(15 + pulse * 5)
                screen_pos = self._get_screen_pos(*self.hint_pos)
                pygame.draw.circle(hint_overlay, (50, 200, 100, 140), screen_pos, radius)
                pygame.draw.circle(hint_overlay, (20, 160, 60, 230), screen_pos, radius, 3)
                self.screen.blit(hint_overlay, (0, 0))
            if self.hint_text:
                text_surf = self._font_md.render("建议: " + self.hint_text, True, (20, 120, 50))
                bg = text_surf.get_rect(midbottom=(self.SCREEN_WIDTH // 2, self.SCREEN_HEIGHT - 55))
                bg.inflate_ip(24, 10)
                pygame.draw.rect(self.screen, (220, 245, 225), bg, border_radius=6)
                pygame.draw.rect(self.screen, (20, 160, 60), bg, 2, border_radius=6)
                self.screen.blit(text_surf, text_surf.get_rect(center=bg.center))

        pygame.display.flip()

    def run(self) -> None:
        self.show_mode_selection()
        running = True

        while running:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    running = False
                elif event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_h:
                        if (not self.game_over and not self.hint_thinking and not self.ai_thinking
                                and (self.ai_player is None or self.current_player != self.ai_player)):
                            self.hint_thinking = True
                            self.hint_pos = None
                            self.hint_show_until = 0
                            threading.Thread(target=self._compute_hint, daemon=True).start()
                elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                    if self._hint_button_rect.collidepoint(event.pos):
                        if (not self.game_over and not self.hint_thinking and not self.ai_thinking
                                and (self.ai_player is None or self.current_player != self.ai_player)):
                            self.hint_thinking = True
                            self.hint_pos = None
                            self.hint_show_until = 0
                            threading.Thread(target=self._compute_hint, daemon=True).start()
                    elif not self.hint_thinking and (self.ai_player is None or self.current_player != self.ai_player):
                        self.hint_show_until = 0
                        self.handle_click(event.pos)

            if (
                not self.game_over
                and self.ai_player is not None
                and self.current_player == self.ai_player
                and not self.ai_thinking
                and self.ai_move_result is None
                and not self.hint_thinking
            ):
                self.ai_thinking = True
                threading.Thread(target=self._ai_compute_move, daemon=True).start()

            if self.ai_move_result is not None:
                result = self.ai_move_result
                self.ai_move_result = None
                self.ai_thinking = False
                self._ai_candidate_show_until = pygame.time.get_ticks() + 1500
                self.hint_show_until = 0
                if result == 'skip':
                    self.handle_skip()
                else:
                    self.handle_click(self._get_screen_pos(*result))

            if self._hint_result is not None:
                res = self._hint_result
                self._hint_result = None
                self.hint_thinking = False
                if res[0] != 'skip':
                    self.hint_pos, self.hint_text = res
                else:
                    self.hint_pos = None
                    self.hint_text = res[1]
                self.hint_show_until = pygame.time.get_ticks() + 5000

            self.draw()
            self.clock.tick(60)

        pygame.quit()
        sys.exit()
