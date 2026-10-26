"""Glickman (2022) Glicko-2 equations, with an explicit fractional period.

Independent implementation of the published algorithm; no third-party source
copied. See docs/product/WECHAT_LADDER_V2.md for parameter provenance and limits.
"""
import math

SCALE = 173.7178
INITIAL_RATING = 1500.0
INITIAL_DEVIATION = 350.0
INITIAL_VOLATILITY = 0.06
TAU = 0.5
EPSILON = 0.000001
# Online defaults borrowed from Lichess, not fitted to this game's population.
MIN_DEVIATION = 45.0
RANKABLE_DEVIATION = 75.0
MAX_VOLATILITY = 0.1
PERIODS_PER_DAY = 0.21436


def g(phi):
    return 1 / math.sqrt(1 + 3 * phi * phi / math.pi ** 2)


def expected(rating, opponent_rating, opponent_deviation):
    z = g(opponent_deviation / SCALE) * (rating - opponent_rating) / SCALE
    # Stable logistic; the clamp is numerical protection, not a rating cap.
    return 1 / (1 + math.exp(-max(-700, min(700, z))))


def deviation_at(deviation, volatility, elapsed_periods):
    return min(INITIAL_DEVIATION, max(MIN_DEVIATION,
        math.sqrt(deviation ** 2 + max(0, elapsed_periods) * (volatility * SCALE) ** 2)))


def update(rating, deviation, volatility, results, *, periods=1.0, weights=None):
    """Return (rating, RD, volatility). results: (opponent R, RD, score).

    periods=1 reproduces the published batch example. The service supplies
    elapsed wall-clock periods for immediate online updates, and applies its
    documented RD/volatility bounds separately.
    """
    weights = [1.0] * len(results) if weights is None else list(weights)
    if len(weights) != len(results) or any(not math.isfinite(w) or w <= 0 for w in weights):
        raise ValueError("Invalid Glicko-2 weights")
    numbers = [rating, deviation, volatility, periods, *(v for row in results for v in row)]
    if not all(math.isfinite(v) for v in numbers) or deviation <= 0 or volatility <= 0 or periods < 0:
        raise ValueError("Invalid Glicko-2 state")
    if any(rd <= 0 or score not in (0, 0.5, 1) for _, rd, score in results):
        raise ValueError("Invalid Glicko-2 result")
    phi = deviation / SCALE
    if not results:
        return rating, math.sqrt(phi * phi + periods * volatility ** 2) * SCALE, volatility
    information, surprise = 0.0, 0.0
    for (opponent, rd, score), weight in zip(results, weights):
        factor, e = g(rd / SCALE), expected(rating, opponent, rd)
        information += weight * factor ** 2 * e * (1 - e)
        surprise += weight * factor * (score - e)
    if information <= 0:
        raise ValueError("Insufficient numerical rating information")
    variance = 1 / information
    delta = variance * surprise
    a = math.log(volatility ** 2)

    def f(x):
        ex = math.exp(x)
        return ex * (delta ** 2 - phi ** 2 - variance - ex) / (2 * (phi ** 2 + variance + ex) ** 2) - (x - a) / TAU ** 2

    left = a
    if delta ** 2 > phi ** 2 + variance:
        right = math.log(delta ** 2 - phi ** 2 - variance)
    else:
        for k in range(1, 101):
            right = a - k * TAU
            if f(right) >= 0:
                break
        else:
            raise ValueError("Glicko-2 bracket did not converge")
    fl, fr = f(left), f(right)
    for _ in range(100):
        if abs(right - left) <= EPSILON:
            break
        middle = left + (left - right) * fl / (fr - fl)
        fm = f(middle)
        if fm * fr <= 0:
            left, fl = right, fr
        else:
            fl /= 2
        right, fr = middle, fm
    else:
        raise ValueError("Glicko-2 update did not converge")
    sigma = math.exp(left / 2)
    prior_variance = phi ** 2 + periods * sigma ** 2
    posterior_variance = 1 / (1 / prior_variance + 1 / variance)
    return rating + SCALE * posterior_variance * surprise, SCALE * math.sqrt(posterior_variance), sigma
