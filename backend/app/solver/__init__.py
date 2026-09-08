"""Plate solvers. Only nova.astrometry.net in v1; the interface allows a local solver later."""

from .base import JobState, Solver, SolveRequest, SolverError, SolveResult, TransientSolverError

__all__ = [
    "JobState",
    "SolveRequest",
    "SolveResult",
    "Solver",
    "SolverError",
    "TransientSolverError",
]
