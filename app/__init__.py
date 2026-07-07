# Must run before any module imports ``qp`` — resolves the verified
# quant-platform library over the built-in placeholder (INTEGRATION.md §4).
from app import qp_loader  # noqa: F401
