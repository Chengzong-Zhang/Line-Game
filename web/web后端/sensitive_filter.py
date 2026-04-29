from __future__ import annotations

import asyncio
import random
import unicodedata
from collections import deque
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Iterable, Optional


class UIStyle(str, Enum):
    ACADEMIC = "academic"
    CASUAL = "casual"


_STYLE_MESSAGES = {
    UIStyle.ACADEMIC: {
        "term": "Identifier Constraint Violation",
        "message": "检测到非法的标识符分量，请符合学术命名规范。",
    },
    UIStyle.CASUAL: {
        "term": "Nickname Blocked",
        "message": "昵称包含敏感词汇，请换一个更文明的名字吧！",
    },
}


@dataclass(frozen=True)
class FilterResult:
    allowed: bool
    original: str
    normalized: str
    ui_style: UIStyle
    matched_word: Optional[str] = None
    replacement: Optional[str] = None

    @property
    def term(self) -> str:
        return _STYLE_MESSAGES[self.ui_style]["term"]

    @property
    def message(self) -> str:
        return _STYLE_MESSAGES[self.ui_style]["message"]

    def error_context(self) -> dict[str, str]:
        return {
            "sensitive_filter": "true",
            "term": self.term,
            "message": self.message,
            "ui_style": self.ui_style.value,
            "matched_word": self.matched_word or "",
            "normalized": self.normalized,
            "suggestion": self.replacement or SensitiveFilter.replacement_name(self.ui_style),
        }


class SensitiveFilter:
    """
    Aho-Corasick DFA for high-throughput nickname checks.

    Build time is proportional to the total dictionary length. Runtime matching is
    O(len(normalized_text) + matches), which keeps request-time validation stable
    even when the word list grows.
    """

    _LEET_MAP = str.maketrans(
        {
            "0": "o",
            "1": "i",
            "!": "i",
            "|": "i",
            "3": "e",
            "4": "a",
            "@": "a",
            "5": "s",
            "$": "s",
            "7": "t",
            "+": "t",
            "8": "b",
            "9": "g",
        }
    )
    _RANDOM = random.SystemRandom()

    def __init__(self) -> None:
        self._goto: list[dict[str, int]] = [{}]
        self._fail: list[int] = [0]
        self._output: list[set[str]] = [set()]
        self._words: frozenset[str] = frozenset()
        self._load_lock = asyncio.Lock()

    @property
    def word_count(self) -> int:
        return len(self._words)

    async def load_from_file(self, file_path: str | Path) -> None:
        path = Path(file_path)
        if not path.exists():
            self.load_words(())
            return

        text = await asyncio.to_thread(path.read_text, encoding="utf-8")
        words = []
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            word = line.split("#", 1)[0].strip()
            if word:
                words.append(word)

        async with self._load_lock:
            self.load_words(words)

    def load_words(self, words: Iterable[str]) -> None:
        normalized_words = {
            normalized
            for word in words
            if (normalized := self.normalize(word))
        }
        goto: list[dict[str, int]] = [{}]
        fail: list[int] = [0]
        output: list[set[str]] = [set()]

        for word in sorted(normalized_words):
            state = 0
            for char in word:
                next_state = goto[state].get(char)
                if next_state is None:
                    next_state = len(goto)
                    goto[state][char] = next_state
                    goto.append({})
                    fail.append(0)
                    output.append(set())
                state = next_state
            output[state].add(word)

        queue: deque[int] = deque()
        for next_state in goto[0].values():
            queue.append(next_state)
            fail[next_state] = 0

        while queue:
            state = queue.popleft()
            for char, next_state in goto[state].items():
                queue.append(next_state)
                fallback = fail[state]
                while fallback and char not in goto[fallback]:
                    fallback = fail[fallback]
                fail[next_state] = goto[fallback].get(char, 0)
                output[next_state].update(output[fail[next_state]])

        self._goto = goto
        self._fail = fail
        self._output = output
        self._words = frozenset(normalized_words)

    def validate(
        self,
        nickname: str,
        ui_style: str | UIStyle = UIStyle.CASUAL,
        auto_correct: bool = False,
    ) -> FilterResult:
        style = self.resolve_style(ui_style)
        normalized = self.normalize(nickname)
        matched_word = self.find_first(normalized)
        if matched_word is None:
            return FilterResult(
                allowed=True,
                original=nickname,
                normalized=normalized,
                ui_style=style,
            )

        replacement = self.replacement_name(style) if auto_correct else None
        return FilterResult(
            allowed=False,
            original=nickname,
            normalized=normalized,
            ui_style=style,
            matched_word=matched_word,
            replacement=replacement,
        )

    def find_first(self, normalized_text: str) -> Optional[str]:
        if not self._words or not normalized_text:
            return None

        state = 0
        for char in normalized_text:
            while state and char not in self._goto[state]:
                state = self._fail[state]
            state = self._goto[state].get(char, 0)
            if self._output[state]:
                return max(self._output[state], key=len)
        return None

    @classmethod
    def normalize(cls, text: str) -> str:
        normalized = unicodedata.normalize("NFKC", str(text)).casefold()
        normalized = normalized.translate(cls._LEET_MAP)

        chars: list[str] = []
        for char in normalized:
            category = unicodedata.category(char)
            if category[0] in {"L", "N"}:
                chars.append(char)
        return "".join(chars)

    @staticmethod
    def resolve_style(ui_style: str | UIStyle) -> UIStyle:
        if isinstance(ui_style, UIStyle):
            return ui_style
        try:
            return UIStyle(str(ui_style).casefold())
        except ValueError:
            return UIStyle.CASUAL

    @classmethod
    def replacement_name(cls, ui_style: str | UIStyle = UIStyle.CASUAL) -> str:
        style = cls.resolve_style(ui_style)
        if style == UIStyle.ACADEMIC:
            return f"Anonymous_Scholar_{cls._RANDOM.randint(1000, 9999)}"
        return f"Node_Alpha_Ref_{cls._RANDOM.randint(1000, 9999)}"
