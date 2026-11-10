#include <vector>
#include <string>

class Shape {
public:
  virtual double area() const = 0;
  virtual ~Shape() = default;
};
