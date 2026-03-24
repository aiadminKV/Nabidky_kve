export { fetchProductsBySkus } from "../services/search.js";
import type { ProductResult } from "../services/search.js";

export const slim = (r: ProductResult) => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  unit: r.unit,
  current_price: r.current_price,
  supplier_name: r.supplier_name,
  category_main: r.category_main,
  category_sub: r.category_sub,
  category_line: r.category_line,
  is_stock_item: r.is_stock_item,
  has_stock: r.has_stock,
  removed_at: r.removed_at,
});
